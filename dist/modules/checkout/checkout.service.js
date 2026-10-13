import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orderFulfillments, orderItems, orders, payments, productVariants, products, } from "../../db/schema.js";
import { env } from "../../env.js";
import { badRequest, conflict, isDuplicateEntry, notFound } from "../../lib/errors.js";
import { newId, newOrderNumber, randomToken, sha256 } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import { computeTotals, priceLine } from "../../lib/money.js";
import { stripe, stripeAmount, toPaymentError } from "../../lib/stripe.js";
import { clearCart } from "../cart/cart.service.js";
import { releaseStock } from "../orders/stock.service.js";
/**
 * Checkout.
 *
 * The most security-sensitive path in the system, so the rules are stated once
 * here and everything else follows:
 *
 * 1. The request carries no prices. Every unit price is re-read from the
 *    catalogue inside the transaction, and the amount handed to Stripe is the
 *    total the server computed. No client-supplied figure reaches the processor.
 * 2. Stock is decremented under `SELECT ... FOR UPDATE`, and every read involved
 *    in that decision runs on the *transaction's own connection* — a lock taken
 *    through the pool while the write happens elsewhere protects nothing.
 * 3. Stripe is called outside the database transaction, keyed by idempotency.
 *    Holding row locks across a network call is how a slow payment provider turns
 *    into a database outage.
 * 4. Resubmitting with the same `idempotencyKey` returns the original order
 *    instead of creating a second one and charging twice.
 */
const MAX_UNITS_PER_LINE = 99;
const MAX_LINES = 50;
/**
 * In-memory grouping key for lines whose product has no supplier assigned.
 *
 * This is a `Map` key only; it is never written to the database. `order_fulfillments.supplier_id`
 * is nullable and stores SQL NULL for an unassigned slice.
 *
 * A string key is needed because `Map` treats `null` as a normal key but mixing
 * `string | null` keys invites accidental `=== null` comparisons against ids. It
 * is built from characters the id validator rejects, so it cannot collide with a
 * real Crockford id.
 */
const UNASSIGNED_SUPPLIER_KEY = "\u0000unassigned";
/** The public shape of a priced line. Internal bookkeeping stays internal. */
const toPriceLine = (line) => ({
    productId: line.productId,
    variantId: line.variantId,
    name: line.name,
    variantLabel: line.variantLabel,
    imageUrl: line.imageUrl,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.lineTotalCents,
});
/**
 * Quote variant of the same mapper.
 *
 * Same omissions as `toPriceLine` — no supplier, no allocation — plus the slug and
 * availability a client-side basket needs to stay in step with the server.
 */
const toQuoteLine = (line) => ({
    ...toPriceLine(line),
    productSlug: line.productSlug,
    isBackorderable: line.isBackorderable,
    stockOnHand: line.stockOnHand,
});
/**
 * Spread a quantity across a product's variants, largest-free and in primary-key
 * order.
 *
 * A basket line that names no variant still has to come out of *some* physical
 * row. Splitting it here — rather than picking one arbitrarily — is what makes
 * the later release exact: whatever the split was, the same numbers go back in.
 *
 * Primary-key order makes the split deterministic, so two quotes of the same
 * basket describe the same rows and the allocation can be compared rather than
 * guessed at.
 */
const spreadAcross = (candidates, quantity) => {
    const allocations = [];
    let remaining = quantity;
    for (const variant of candidates) {
        if (remaining <= 0)
            break;
        // A made-to-order variant can hold a negative count. It has nothing to give,
        // so it is skipped rather than driving the total further down.
        const take = Math.min(remaining, Math.max(variant.stockOnHand, 0));
        if (take <= 0)
            continue;
        allocations.push({ variantId: variant.id, quantity: take });
        remaining -= take;
    }
    return allocations;
};
/**
 * Re-price a set of lines from live catalogue data.
 *
 * Shared by `quote` and `createOrder` so the figure shown in the bag is produced
 * by exactly the code that will charge the card. If these two ever diverged, the
 * difference would appear as a surprise charge at the payment step.
 *
 * `executor` must be the checkout transaction when `forUpdate` is set. Passing
 * the pool instead would take the lock on one connection and write on another.
 */
const resolveLines = async (executor, items, options) => {
    if (items.length > MAX_LINES)
        throw badRequest("Too many distinct items in one order.");
    // Reject duplicate lines so one product cannot be smuggled in twice with a split
    // quantity, which would sidestep the per-line stock cap.
    const seen = new Set();
    for (const item of items) {
        const key = `${item.productSlug}::${item.variantId ?? ""}`;
        if (seen.has(key))
            throw badRequest("Your bag lists the same item more than once.");
        seen.add(key);
        if (item.quantity < 1 || item.quantity > MAX_UNITS_PER_LINE)
            throw badRequest("Invalid quantity.");
    }
    const slugs = items.map((i) => i.productSlug);
    /**
     * Products are locked first, then variants, and each set in primary-key order.
     *
     * The order matters for more than tidiness. Locking variants before products
     * would let two baskets that name the same two products in opposite request
     * order hold one product each and wait on the other's variant — a deadlock. A
     * single global order over both tables removes the cycle.
     */
    const productBase = executor
        .select()
        .from(products)
        .where(and(inArray(products.slug, slugs), eq(products.isActive, true)))
        .orderBy(products.id);
    const productRows = options.forUpdate ? await productBase.for("update") : await productBase;
    // Early return if no products were found
    if (productRows.length === 0) {
        // Destructured rather than indexed: `noUncheckedIndexedAccess` types
        // `items[0]` as possibly-undefined even under the length guard, so the
        // indexed access would not typecheck.
        const [first] = items;
        if (items.length === 1 && first) {
            throw notFound(`"${first.productSlug}" is no longer available.`);
        }
        throw badRequest("None of the requested products are available.");
    }
    const productBySlug = new Map(productRows.map((p) => [p.slug, p]));
    const productIds = productRows.map((p) => p.id);
    /**
     * Every active variant of every product in the basket is loaded, not only the
     * ones the request named.
     *
     * A line that names no variant draws on its product's variants collectively, so
     * its availability cannot be decided from a subset of them. More importantly
     * the aggregate and the per-variant decisions have to come from a single
     * snapshot: locking only the named variants would let one basket naming a size
     * and another naming none each read a total that includes stock the other is
     * about to take, and both would pass the check and oversell.
     */
    const variantBase = executor
        .select()
        .from(productVariants)
        .where(productIds.length === 0
        ? sql `1 = 0`
        : and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
        .orderBy(productVariants.id);
    const variantRows = options.forUpdate ? await variantBase.for("update") : await variantBase;
    const variantById = new Map(variantRows.map((v) => [v.id, v]));
    const variantsByProduct = new Map();
    for (const variant of variantRows) {
        const bucket = variantsByProduct.get(variant.productId);
        if (bucket)
            bucket.push(variant);
        else
            variantsByProduct.set(variant.productId, [variant]);
    }
    const lines = [];
    for (const item of items) {
        const product = productBySlug.get(item.productSlug);
        if (!product)
            throw notFound(`"${item.productSlug}" is no longer available.`);
        // The product's variants, in primary-key order, which is the order
        // `spreadAcross` consumes them in.
        const candidates = variantsByProduct.get(product.id) ?? [];
        let variant;
        if (item.variantId) {
            const found = variantById.get(item.variantId);
            if (!found)
                throw badRequest("That option is no longer available.");
            // A variant of a *different* product in the same basket is present in the
            // map but must not be accepted here. Rejecting rather than ignoring it:
            // silently dropping it would charge for a different item than the one
            // displayed.
            if (found.productId !== product.id)
                throw badRequest("That option does not belong to this product.");
            variant = found;
        }
        const isBackorderable = variant?.isBackorderable ?? false;
        const available = variant
            ? variant.stockOnHand
            : candidates.reduce((sum, v) => sum + v.stockOnHand, 0);
        if (!isBackorderable && available < item.quantity) {
            throw conflict(available === 0 ? `${product.name} is sold out.` : `Only ${available} of ${product.name} left in stock.`);
        }
        /**
         * A named variant is decremented whole. An unnamed one is split across the
         * product's variants, so the stock it removes is as real as a named line's —
         * previously these lines were skipped by `decrementStock` altogether, which
         * meant they sold the same units repeatedly until the catalogue ran out.
         */
        const allocations = variant
            ? [{ variantId: variant.id, quantity: item.quantity }]
            : spreadAcross(candidates, item.quantity);
        lines.push(priceLine({
            productId: product.id,
            productSlug: product.slug,
            variantId: variant?.id ?? null,
            supplierId: product.supplierId,
            isBackorderable,
            allocations,
            name: product.name,
            variantLabel: variant ? [variant.colorName, variant.size].filter(Boolean).join(" / ") || null : null,
            imageUrl: product.imageUrl,
            quantity: item.quantity,
            unitPriceCents: variant?.unitPriceCents ?? product.unitPriceCents,
            stockOnHand: available,
        }));
    }
    return lines;
};
/**
 * Price a basket without creating anything, so the checkout page can show a
 * total the shopper can trust.
 */
export const quote = async (items) => {
    const lines = await resolveLines(db, items, { forUpdate: false });
    // Narrowed to `QuoteLine` on the way out: the resolved lines also carry the
    // supplier id and the stock allocation, and a public price quote has no reason
    // to disclose which wholesaler sources an item.
    return { lines: lines.map(toQuoteLine), totals: computeTotals(lines) };
};
/**
 * Decrement the stock each line reserved.
 *
 * Runs on the transaction handle, on the same connection that took the lock. The
 * `stock_on_hand >= quantity` predicate makes the write itself conditional, so
 * the database is the final authority even if the lock were somehow skipped.
 */
const decrementStock = async (tx, lines) => {
    for (const line of lines) {
        // Iterate the recorded allocation rather than `line.variantId`. A line that
        // named no variant still drew real stock out of one or more rows, and
        // skipping those was how a basket could buy the same sold-out item twice.
        for (const allocation of line.allocations) {
            const [result] = await tx
                .update(productVariants)
                .set({ stockOnHand: sql `${productVariants.stockOnHand} - ${allocation.quantity}` })
                .where(and(eq(productVariants.id, allocation.variantId), line.isBackorderable
                ? eq(productVariants.isBackorderable, true)
                : sql `(${productVariants.isBackorderable} = 1 OR ${productVariants.stockOnHand} >= ${allocation.quantity})`));
            if ((result.affectedRows ?? 0) === 0) {
                // The lock was meant to make this unreachable. Getting here means the
                // invariant broke, so fail the order rather than oversell.
                throw conflict(`${line.name} sold out while you were checking out.`);
            }
        }
    }
};
/**
 * Split an order into one fulfillment per supplier — the dropshipping fan-out.
 *
 * A basket spanning three suppliers becomes three purchase orders, each tracking
 * its own shipping so one late supplier cannot hold up the rest. Products with no
 * supplier are grouped under a single unassigned row instead of being dropped, so
 * an operator can see and fix them.
 */
const buildFulfillmentGroups = (lines) => {
    const groups = new Map();
    for (const line of lines) {
        const key = line.supplierId ?? UNASSIGNED_SUPPLIER_KEY;
        const existing = groups.get(key);
        if (existing)
            existing.push(line);
        else
            groups.set(key, [line]);
    }
    return groups;
};
/**
 * Create an order and its PaymentIntent.
 *
 * Side-effect order is deliberate:
 *
 *   1. Transaction — lock variants, price, insert order/items/fulfillments,
 *      decrement stock. Commits, releasing every lock.
 *   2. Stripe — create the PaymentIntent against the *committed* total, keyed by
 *      the order id so a retry cannot produce a second charge.
 *   3. Transaction — record the PaymentIntent against the order.
 *
 * A crash between 1 and 2 leaves a `pending_payment` order with no payment row.
 * That is recoverable by resubmitting the same key, which is what `resumeOrder`
 * is for, rather than stranding the shopper's order.
 */
export const createOrder = async (input, userId) => {
    // Replay guard, part one: an order already exists for this key.
    const existing = await db.select().from(orders).where(eq(orders.idempotencyKey, input.idempotencyKey)).limit(1);
    const existingOrder = existing[0];
    if (existingOrder) {
        // A key represents one shopper's intent. If it exists but belongs to a
        // different account, refuse rather than hand back another user's order and
        // its client secret.
        if (existingOrder.userId !== userId)
            throw badRequest("That idempotency key has already been used.");
        return resumeOrder(existingOrder);
    }
    const orderId = newId();
    const orderNumber = newOrderNumber();
    // Only a guest order needs a claim token; an account order is claimed by session.
    const guestClaimToken = userId ? null : randomToken(24);
    const committed = await db.transaction(async (tx) => {
        // Resolved on `tx`, so the row locks belong to this transaction's connection.
        const lines = await resolveLines(tx, input.items, { forUpdate: true });
        const totals = computeTotals(lines);
        if (totals.totalCents <= 0)
            throw badRequest("Order total must be greater than zero.");
        try {
            await tx.insert(orders).values({
                id: orderId,
                orderNumber,
                userId,
                guestEmail: userId ? null : input.email,
                guestClaimTokenHash: guestClaimToken ? sha256(guestClaimToken) : null,
                shippingName: input.shipping.recipientName,
                shippingLine1: input.shipping.line1,
                shippingLine2: input.shipping.line2 ?? null,
                shippingCity: input.shipping.city,
                shippingPostalCode: input.shipping.postalCode,
                shippingCountry: input.shipping.country,
                shippingPhone: input.shipping.phone ?? null,
                currency: totals.currency,
                subtotalCents: totals.subtotalCents,
                shippingCents: totals.shippingCents,
                taxCents: totals.taxCents,
                totalCents: totals.totalCents,
                status: "pending_payment",
                idempotencyKey: input.idempotencyKey,
                placedAt: new Date(),
            });
        }
        catch (error) {
            // Lost the race against a concurrent identical submit. The other request
            // will finish that order, so surface a conflict rather than create a second.
            if (isDuplicateEntry(error))
                throw conflict("A duplicate order is already being processed.");
            throw error;
        }
        await tx.insert(orderItems).values(lines.map((line) => ({
            id: newId(),
            orderId,
            productId: line.productId,
            productName: line.name,
            productSlug: line.productSlug,
            variantId: line.variantId,
            variantLabel: line.variantLabel,
            imageUrl: line.imageUrl,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            // Persisted so a cancellation can hand the exact stock back. Without it a
            // line bought without naming a variant has no record of what it consumed,
            // and the units it took can only be stranded.
            variantAllocations: line.allocations,
        })));
        await tx.insert(orderFulfillments).values([...buildFulfillmentGroups(lines)].map(([key]) => ({
            id: newId(),
            orderId,
            // The unassigned grouping key is an in-memory sentinel and must not be
            // written: `supplier_id` is a real FK, so only an actual supplier id or
            // SQL NULL is storable. NULL marks the slice as needing assignment.
            supplierId: key === UNASSIGNED_SUPPLIER_KEY ? null : key,
            status: "pending",
        })));
        await decrementStock(tx, lines);
        const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
        return { order: row, totals };
    });
    // Committed, and every row lock is released, before Stripe is contacted.
    let result;
    try {
        result = await attachPayment(committed.order, committed.totals.totalCents, committed.totals.currency, {
            email: input.email,
            guestClaimToken,
        });
    }
    catch (error) {
        // If Stripe fails, we should release the stock that was reserved and cancel the order.
        // This is critical to prevent inventory from being permanently held.
        logger.error({ orderId, error }, "Stripe payment failed, canceling order and releasing stock");
        try {
            // Cancel the order to mark it as failed
            await db.update(orders).set({ status: "failed" }).where(eq(orders.id, orderId));
            // Release the stock
            await releaseStock(orderId);
        }
        catch (rollbackError) {
            // If rollback fails, log it but still throw the original error
            logger.error({ orderId, error: rollbackError }, "Failed to rollback order after Stripe error");
        }
        throw error;
    }
    // Only emptied once payment is initialised, so a failure above leaves the bag
    // intact and the shopper can try again.
    if (userId) {
        try {
            await clearCart(userId);
        }
        catch (cartError) {
            // Cart clearing failure is non-critical: the order is already created and paid.
            // Log it but don't fail the checkout.
            logger.error({ userId, orderId, error: cartError }, "Failed to clear cart after successful checkout");
        }
    }
    return result;
};
/**
 * Create the PaymentIntent and record it against the order.
 *
 * The Stripe idempotency key is the *order id*: Stripe scopes a key to one logical
 * operation, and the order id uniquely identifies this payment attempt. Re-running
 * this for the same order returns the original intent instead of charging twice.
 */
const attachPayment = async (order, totalCents, currency, context) => {
    let intent;
    try {
        intent = await stripe.paymentIntents.create({
            ...stripeAmount(totalCents, currency),
            // Automatic methods keep the client able to offer link, wallets and new
            // options without a server change.
            automatic_payment_methods: { enabled: true },
            receipt_email: context.email,
            description: `Order ${order.orderNumber}`,
            metadata: {
                orderId: order.id,
                orderNumber: order.orderNumber,
                userId: order.userId ?? "",
            },
        }, { idempotencyKey: order.id });
    }
    catch (error) {
        throw toPaymentError(error);
    }
    if (!intent.client_secret) {
        // Not expected for a PaymentIntent, but a missing client secret would reach
        // the browser as a checkout that cannot complete.
        throw badRequest("The payment could not be initialised. Please try again.");
    }
    await db.transaction(async (tx) => {
        try {
            await tx.insert(payments).values({
                id: newId(),
                orderId: order.id,
                stripePaymentIntentId: intent.id,
                status: "requires_payment_method",
                amountCents: totalCents,
                currency,
            });
        }
        catch (error) {
            // A concurrent resume already recorded a PaymentIntent. The unique index on
            // stripe_payment_intent_id proves the two are the same object, so the
            // earlier row stands and this attempt is a no-op.
            if (!isDuplicateEntry(error))
                throw error;
            return;
        }
        await tx
            .update(orders)
            .set({ status: "pending_payment" })
            .where(eq(orders.id, order.id));
    });
    return {
        order,
        orderNumber: order.orderNumber,
        clientSecret: intent.client_secret,
        publishableKey: env.stripePublishableKey,
        ...(context.guestClaimToken ? { guestClaimToken: context.guestClaimToken } : {}),
        replayed: false,
    };
};
/**
 * Finish an order whose payment row is missing.
 *
 * Reached when a previous attempt committed the order but died before Stripe was
 * called — a deploy, a timeout, a process kill. The order's stored totals are the
 * source of truth, so the resumed intent charges exactly what was committed.
 */
const resumeOrder = async (order) => {
    const existingPayment = await db.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    const paymentRow = existingPayment[0];
    if (paymentRow) {
        // The payment exists; re-fetch it to hand back a client secret for an object
        // already known, rather than creating a second intent.
        let intent;
        try {
            intent = await stripe.paymentIntents.retrieve(paymentRow.stripePaymentIntentId);
        }
        catch (error) {
            throw toPaymentError(error);
        }
        if (!intent.client_secret)
            throw badRequest("This order can no longer be paid.");
        return {
            order,
            orderNumber: order.orderNumber,
            clientSecret: intent.client_secret,
            publishableKey: env.stripePublishableKey,
            replayed: true,
        };
    }
    return attachPayment(order, order.totalCents, order.currency, {
        // A guest claim token is never re-issued: the original was handed to the
        // browser once and is not recoverable from its hash.
        email: order.guestEmail ?? "",
        guestClaimToken: null,
    });
};
//# sourceMappingURL=checkout.service.js.map