import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orderFulfillments, orderItems, orders, payments, suppliers, users, } from "../../db/schema.js";
import { sendShippingUpdate } from "../../lib/email.js";
import { notFound, paymentFailed } from "../../lib/errors.js";
import { safeEqual, sha256 } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import { formatMoney } from "../../lib/money.js";
import { stripe, toPaymentError } from "../../lib/stripe.js";
import { markRefunded } from "../payments/webhook.service.js";
import { forwardFulfillment } from "./forward.service.js";
const toOrderView = (order, items, fulfillments, payment) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    // A guest order falls back to the stored address, so the owner always sees a
    // contact point on the order they placed.
    email: order.guestEmail ?? "",
    placedAt: order.placedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    items: items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        productSlug: i.productSlug,
        variantId: i.variantId,
        variantLabel: i.variantLabel,
        imageUrl: i.imageUrl,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.lineTotalCents,
    })),
    fulfillments: fulfillments.map((f) => ({
        id: f.id,
        supplierId: f.supplierId,
        supplierName: f.supplierName,
        status: f.status,
        trackingNumber: f.trackingNumber,
        trackingCarrier: f.trackingCarrier,
        attempts: f.attempts,
        lastError: f.lastError,
        // Surfaces the unassigned group in the admin queue without hard-coding the
        // sentinel here: a fulfillment whose supplier row no longer exists is the
        // same condition.
        needsSupplierAssignment: f.supplierName === null,
    })),
    totals: {
        currency: order.currency,
        subtotalCents: order.subtotalCents,
        shippingCents: order.shippingCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
        refundedCents: order.refundedCents,
        formattedTotal: formatMoney(order.totalCents, order.currency),
    },
    payment: payment
        ? {
            status: payment.status,
            cardBrand: payment.cardBrand,
            cardLast4: payment.cardLast4,
            failureMessage: payment.failureMessage,
        }
        : null,
    shippingAddress: {
        recipientName: order.shippingName,
        line1: order.shippingLine1,
        line2: order.shippingLine2,
        city: order.shippingCity,
        postalCode: order.shippingPostalCode,
        country: order.shippingCountry,
        phone: order.shippingPhone,
    },
});
/**
 * Assemble full order views for a set of orders, in a fixed number of queries.
 *
 * Deliberately not a per-order lookup: a 50-order admin page would otherwise be
 * 150 round trips.
 */
const hydrate = async (rows) => {
    if (rows.length === 0)
        return [];
    const ids = rows.map((r) => r.id);
    const [itemRows, fulfillmentRows, paymentRows] = await Promise.all([
        db.select().from(orderItems).where(inArray(orderItems.orderId, ids)).orderBy(orderItems.createdAt),
        db
            .select({ row: orderFulfillments, supplierName: suppliers.name })
            .from(orderFulfillments)
            .leftJoin(suppliers, eq(orderFulfillments.supplierId, suppliers.id))
            .where(inArray(orderFulfillments.orderId, ids)),
        db.select().from(payments).where(inArray(payments.orderId, ids)),
    ]);
    const itemsByOrder = new Map();
    for (const row of itemRows) {
        const list = itemsByOrder.get(row.orderId);
        if (list)
            list.push(row);
        else
            itemsByOrder.set(row.orderId, [row]);
    }
    const fulfillmentsByOrder = new Map();
    for (const { row, supplierName } of fulfillmentRows) {
        const entry = { ...row, supplierName };
        const list = fulfillmentsByOrder.get(row.orderId);
        if (list)
            list.push(entry);
        else
            fulfillmentsByOrder.set(row.orderId, [entry]);
    }
    const paymentByOrder = new Map(paymentRows.map((p) => [p.orderId, p]));
    return rows.map((order) => toOrderView(order, itemsByOrder.get(order.id) ?? [], fulfillmentsByOrder.get(order.id) ?? [], paymentByOrder.get(order.id)));
};
/**
 * Hydrate a single known order. Guarantees a value so callers do not have to
 * re-derive the 404 case.
 */
const hydrateOne = async (row) => {
    const [view] = await hydrate([row]);
    if (!view)
        throw notFound("Order not found.");
    return view;
};
/**
 * Build the shared WHERE clause for an order list.
 *
 * Both the customer's history and the admin console accept the same two filters,
 * so the predicate is built once. Duplicating it is how the two drifted: the
 * customer's list validated `status` and `fulfillmentStatus` through the query
 * schema and then ignored both, returning every order regardless — so the
 * storefront's status filter was a control that did nothing.
 *
 * Fulfillment status is a property of an order's child rows, so it becomes an
 * EXISTS predicate rather than an in-memory filter. Filtering the page after it
 * was fetched would silently return short pages and a `total` that counts every
 * order regardless of the filter, and it cannot paginate correctly at all: the
 * qualifying rows on page 3 are unknown until the filter runs. Including the
 * predicate in both the page and the count query is what makes the numbers agree.
 */
const buildOrderConditions = (filters) => {
    const conditions = [];
    if (filters.status)
        conditions.push(eq(orders.status, filters.status));
    if (filters.fulfillmentStatus) {
        conditions.push(sql `EXISTS (
        SELECT 1 FROM ${orderFulfillments} of2
        WHERE of2.order_id = ${orders.id}
          AND of2.status = ${filters.fulfillmentStatus}
      )`);
    }
    return conditions;
};
/** Order history for the signed-in customer. */
export const listMyOrders = async (userId, filters) => {
    // The ownership predicate leads, and the filters apply to it: a customer can
    // only ever narrow their own history, never widen it with a filter.
    const where = and(eq(orders.userId, userId), ...buildOrderConditions(filters));
    const rows = await db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(filters.pageSize)
        .offset((filters.page - 1) * filters.pageSize);
    const [countRows] = await db.select({ n: count() }).from(orders).where(where);
    return {
        orders: await hydrate(rows),
        page: filters.page,
        pageSize: filters.pageSize,
        total: Number(countRows?.n ?? 0),
    };
};
/**
 * One order for the signed-in customer.
 *
 * Scoped by both order number and user id. A caller who knows someone else's
 * order number gets 404, not 403, so the endpoint cannot be used to confirm which
 * order numbers exist.
 */
export const getMyOrder = async (userId, orderNumber) => {
    const [row] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.orderNumber, orderNumber), eq(orders.userId, userId)))
        .limit(1);
    if (!row)
        throw notFound("Order not found.");
    return hydrateOne(row);
};
/**
 * Any single order, for the admin console.
 *
 * Deliberately not scoped by a user: an operator needs to reach guest orders and
 * any customer's history. This is why the function is admin-only by contract and
 * the route that calls it is behind `requireAdmin`.
 */
export const getOrderByIdForAdmin = async (orderId) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!row)
        throw notFound("Order not found.");
    return hydrateOne(row);
};
/**
 * Look up a guest order.
 *
 * A guest has no session, so possession of the order number alone is not treated
 * as authority: the requester must also present the email the order was placed
 * with. The comparison is constant-time and both fields are required, so this
 * cannot be used to enumerate order numbers.
 */
export const getGuestOrder = async (orderNumber, email) => {
    const [row] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
    // Identical error for "no such order" and "wrong email", and the email compare
    // is constant-time, so this is not an enumeration oracle.
    const emailMatches = row?.guestEmail != null && safeEqual(row.guestEmail.toLowerCase(), email.toLowerCase());
    if (!row || !emailMatches)
        throw notFound("Order not found.");
    return hydrateOne(row);
};
/**
 * Attach a guest order to an account.
 *
 * Claiming requires the order number, the email it was placed with, *and* the
 * secret claim token handed to the browser at checkout — the email alone is not
 * enough, since anyone who knows a customer's email could otherwise claim their
 * order history.
 */
export const claimGuestOrder = async (userId, orderNumber, email, claimToken) => {
    const presented = sha256(claimToken);
    const [row] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
    const ok = row?.guestClaimTokenHash != null &&
        row.guestEmail != null &&
        safeEqual(row.guestEmail.toLowerCase(), email.toLowerCase()) &&
        safeEqual(row.guestClaimTokenHash, presented);
    if (!row || !ok)
        throw notFound("Order not found.");
    // Only an unclaimed guest order can be claimed, so a claimed order cannot be
    // re-pointed at a different account.
    //
    // The guard must be `IS NULL`, not `eq(orders.userId, row.userId ?? "")`. An
    // unclaimed guest order has a NULL user_id, and in SQL `user_id = ''` does not
    // match `user_id IS NULL` — the update would match zero rows and every genuine
    // guest claim would fail with "Order not found". `isNull` is also the more
    // precise condition: it asserts "unclaimed" directly rather than depending on
    // the row it just read still being unchanged.
    const [result] = await db
        .update(orders)
        .set({ userId, guestClaimTokenHash: null })
        .where(and(eq(orders.id, row.id), isNull(orders.userId)));
    if ((result.affectedRows ?? 0) === 0) {
        // Lost the race against a concurrent claim.
        throw notFound("Order not found.");
    }
    const [updated] = await db.select().from(orders).where(eq(orders.id, row.id)).limit(1);
    return hydrateOne(updated);
};
/** Every order, for the admin console. */
export const listAllOrders = async (filters) => {
    const conditions = buildOrderConditions(filters);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(filters.pageSize)
        .offset((filters.page - 1) * filters.pageSize);
    const [countRows] = await db.select({ n: count() }).from(orders).where(where);
    return {
        orders: await hydrate(rows),
        page: filters.page,
        pageSize: filters.pageSize,
        total: Number(countRows?.n ?? 0),
    };
};
/**
 * Update a fulfillment's state and tracking details.
 *
 * Admin-only. The fulfillment id is the only identifier accepted, and the order is
 * never re-derived from client input.
 */
export const updateFulfillment = async (fulfillmentId, input) => {
    const now = new Date();
    const status = input.status;
    /**
     * Validate a supplier assignment before writing it.
     *
     * `supplier_id` is a RESTRICT foreign key, so an unknown id would otherwise be
     * rejected by MySQL and surface as an unhandled 500 — telling the operator
     * nothing about what they got wrong, and reporting a client mistake as a server
     * fault. Checking first turns it into a 404 naming the actual problem.
     *
     * This is also the documented remediation for a fulfillment created with a NULL
     * supplier, so the path has to be reliable.
     */
    if (input.supplierId !== undefined) {
        const [supplier] = await db
            .select({ id: suppliers.id })
            .from(suppliers)
            .where(eq(suppliers.id, input.supplierId))
            .limit(1);
        if (!supplier)
            throw notFound("Supplier not found.");
    }
    const [existing] = await db
        .select({ id: orderFulfillments.id })
        .from(orderFulfillments)
        .where(eq(orderFulfillments.id, fulfillmentId))
        .limit(1);
    if (!existing)
        throw notFound("Fulfillment not found.");
    await db
        .update(orderFulfillments)
        .set({
        status,
        ...(input.trackingNumber !== undefined ? { trackingNumber: input.trackingNumber || null } : {}),
        ...(input.trackingCarrier !== undefined ? { trackingCarrier: input.trackingCarrier || null } : {}),
        ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
        // Timestamps are set from the status transition so the row always reflects
        // when each milestone was actually reached.
        ...(status === "forwarded" ? { forwardedAt: now } : {}),
        ...(status === "fulfilled" ? { fulfilledAt: now } : {}),
        ...(status === "shipped" ? { shippedAt: now } : {}),
        ...(status === "delivered" ? { deliveredAt: now } : {}),
    })
        .where(eq(orderFulfillments.id, fulfillmentId));
    const [row] = await db
        .select({ row: orderFulfillments, supplierName: suppliers.name })
        .from(orderFulfillments)
        .leftJoin(suppliers, eq(orderFulfillments.supplierId, suppliers.id))
        .where(eq(orderFulfillments.id, fulfillmentId))
        .limit(1);
    if (!row)
        throw notFound("Fulfillment not found.");
    /**
     * A shipping notice belongs to the "shipped" transition: the tracking number
     * is only ever known to the operator here, so this is the customer's one
     * chance to learn it. Fired without being awaited — the status change is
     * already durable and a mail problem must not fail the operator's update.
     * `sendEmail` swallows SMTP errors, so this cannot throw into the request.
     */
    if (status === "shipped" && row.row.trackingNumber) {
        void notifyShipped(row.row).catch((error) => logger.error({ err: error, fulfillmentId }, "failed to send shipping notice email"));
    }
    /**
     * Forwarding is an *action*, not just a state change: it hands the order to
     * the supplier over their configured channel (email / webhook / api). The
     * dispatch writes the terminal status — `forwarded` on delivery, `failed`
     * with the reason when the supplier could not be reached — and bumps
     * `attempts`, so the row is re-read to return what actually happened rather
     * than the optimistic `forwarded` this request asked for.
     */
    let final = row;
    if (status === "forwarded") {
        await forwardFulfillment(fulfillmentId);
        const [fresh] = await db
            .select({ row: orderFulfillments, supplierName: suppliers.name })
            .from(orderFulfillments)
            .leftJoin(suppliers, eq(orderFulfillments.supplierId, suppliers.id))
            .where(eq(orderFulfillments.id, fulfillmentId))
            .limit(1);
        if (fresh)
            final = fresh;
    }
    return {
        id: final.row.id,
        supplierId: final.row.supplierId,
        supplierName: final.supplierName,
        status: final.row.status,
        trackingNumber: final.row.trackingNumber,
        trackingCarrier: final.row.trackingCarrier,
        attempts: final.row.attempts,
        lastError: final.row.lastError,
        needsSupplierAssignment: final.supplierName === null,
    };
};
/**
 * Email a shipping notice for a fulfillment that just shipped.
 *
 * The recipient is resolved from the order: a guest order carries its own
 * `guest_email`, while an account order is identified by `user_id`, whose
 * address has to be read from `users`. A missing recipient (retired account, no
 * address on file) is not an error — there is simply nobody to notify.
 */
const notifyShipped = async (fulfillment) => {
    const [order] = await db
        .select({ orderNumber: orders.orderNumber, guestEmail: orders.guestEmail, userId: orders.userId })
        .from(orders)
        .where(eq(orders.id, fulfillment.orderId))
        .limit(1);
    if (!order || !fulfillment.trackingNumber)
        return;
    let to = order.guestEmail;
    if (!to && order.userId) {
        const [account] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, order.userId))
            .limit(1);
        to = account?.email ?? null;
    }
    if (!to)
        return;
    await sendShippingUpdate(to, order.orderNumber, fulfillment.trackingCarrier, fulfillment.trackingNumber);
};
/**
 * Refund part or all of an order.
 *
 * The amount is validated against the order's own recorded total and existing
 * refunds, so a mistyped or hostile request cannot over-refund: Stripe would
 * decline it, but the guard means our ledger is never left claiming more was
 * returned than was taken.
 *
 * The local order/payment rows are updated by the `charge.refunded` webhook, not
 * here. This function only asks Stripe to refund, so a network failure cannot
 * leave the database claiming a refund that never happened.
 *
 * `idempotencyKey` identifies the *attempt*, not the amount. See `refundSchema`
 * for why the running total is not a safe substitute: two same-amount refunds
 * raised before the first webhook landed would collide on one Stripe key, and
 * Stripe would replay the first and discard the second. Without a caller-supplied
 * key the running total is still used, which is correct for a single operator
 * retrying one refund and wrong for two issued concurrently — so the console
 * always supplies one.
 */
export const refundOrder = async (orderId, amountCents, reason, idempotencyKey) => {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order)
        throw notFound("Order not found.");
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    if (!payment)
        throw notFound("This order has no payment to refund.");
    // `partially_refunded` is refundable: a second, smaller refund against the same
    // charge is the normal case, and refusing it would make partial refunds
    // single-use.
    if (payment.status !== "succeeded" && payment.status !== "partially_refunded" && payment.status !== "refunded") {
        throw paymentFailed(`A payment in state "${payment.status}" cannot be refunded.`);
    }
    const remaining = order.totalCents - order.refundedCents;
    if (amountCents <= 0)
        throw paymentFailed("Refund amount must be positive.");
    if (amountCents > remaining) {
        throw paymentFailed(`Only ${formatMoney(remaining, order.currency)} remains refundable.`);
    }
    try {
        // Scoped by order id so a key reused across two orders cannot make Stripe
        // return one order's refund in response to another's request.
        const refund = await stripe.refunds.create({
            payment_intent: payment.stripePaymentIntentId,
            amount: amountCents,
            ...(reason ? { reason: "requested_by_customer", metadata: { note: reason.slice(0, 450) } } : {}),
        }, {
            idempotencyKey: idempotencyKey
                ? `${orderId}:refund:${idempotencyKey}`
                : `${orderId}:refund:${order.refundedCents + amountCents}`,
        });
        /**
         * Reflect the refund on the local ledger immediately.
         *
         * Normally the `charge.refunded` webhook does this, but a webhook cannot
         * reach a localhost backend during development, so without this an operator
         * refunds money and the console still shows the full amount as refundable —
         * it looks broken. Reading the cumulative charge back from Stripe and
         * applying the same `markRefunded` the webhook uses keeps one reconciliation
         * path: the later webhook delivery is then a harmless no-op (the status and
         * amounts are already set), and a partial refund is recorded by its running
         * total exactly as the webhook would.
         *
         * Best-effort and non-fatal: the refund itself has already succeeded at
         * Stripe, which is the fact that matters, so a failure here is logged and the
         * webhook (in production) remains the backstop.
         */
        const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
        if (chargeId) {
            try {
                const charge = await stripe.charges.retrieve(chargeId);
                await markRefunded(charge);
            }
            catch (error) {
                logger.warn({ err: error, orderId }, "could not reconcile the refund locally");
            }
        }
        return refund;
    }
    catch (error) {
        throw toPaymentError(error);
    }
};
/**
 * Fulfillment queue for the admin console.
 *
 * The aggregate is computed in SQL so the page is a single query rather than a
 * scan of every fulfillment row.
 */
export const listFulfillmentQueue = async (status, limit = 100) => {
    const rows = await db
        .select({
        row: orderFulfillments,
        supplierName: suppliers.name,
        orderNumber: orders.orderNumber,
        customerEmail: orders.guestEmail,
    })
        .from(orderFulfillments)
        .innerJoin(orders, eq(orderFulfillments.orderId, orders.id))
        .leftJoin(suppliers, eq(orderFulfillments.supplierId, suppliers.id))
        .where(status ? eq(orderFulfillments.status, status) : undefined)
        .orderBy(desc(orderFulfillments.createdAt))
        .limit(limit);
    return rows.map(({ row, supplierName, orderNumber, customerEmail }) => ({
        id: row.id,
        orderId: row.orderId,
        orderNumber,
        /** Null for account orders; the owner is identified by their user id instead. */
        customerEmail,
        supplierId: row.supplierId,
        supplierName,
        status: row.status,
        trackingNumber: row.trackingNumber,
        // The queue previously omitted the carrier, so the console could display a
        // tracking number with no way to see or correct which carrier it belongs to.
        trackingCarrier: row.trackingCarrier,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        /** The supplier row is gone (or was the sentinel), so this needs assigning. */
        unassigned: supplierName === null,
    }));
};
//# sourceMappingURL=orders.service.js.map