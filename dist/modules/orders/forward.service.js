import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orderFulfillments, orderItems, orders, suppliers, users } from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { randomToken, safeEqual } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import { sendDeliveredUpdate, sendShippingUpdate, sendSupplierPurchaseOrder, } from "../../lib/email.js";
/**
 * Supplier forwarding — the outbound half of dropshipping.
 *
 * Marking a fulfillment `forwarded` used to change a column and nothing else, so
 * a supplier was never actually told about the order. This module is what turns
 * that status into a real purchase order: an email to the supplier's inbox, or
 * a signed POST to their webhook/API.
 *
 * The counterpart is `applySupplierCallback`, the inbound path a supplier uses
 * to report back — which is how an order becomes `shipped` or `delivered`
 * without an operator retyping a tracking number.
 *
 * Two identifiers make this safe:
 *  - `forwardedReference` is a random idempotency token sent with the order, so
 *    a supplier that deduplicates will not receive it twice if we retry.
 *  - The same value is the bearer token the supplier presents on the callback,
 *    which is why it is generated per fulfillment and never reused.
 */
const DISPATCH_TIMEOUT_MS = 10_000;
/** POST a JSON body to a supplier endpoint, HMAC-signed when a secret exists. */
const postToSupplier = async (url, body, secret) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const raw = JSON.stringify(body);
        const headers = { "content-type": "application/json" };
        if (secret) {
            // The signature lets the supplier prove the request came from us and was
            // not altered in transit. Over the exact bytes we sent.
            headers["x-edm-signature"] = createHmac("sha256", secret).update(raw).digest("hex");
        }
        const response = await fetch(url, { method: "POST", headers, body: raw, signal: controller.signal });
        if (!response.ok)
            return { ok: false, error: `Supplier endpoint returned HTTP ${response.status}.` };
        return { ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Network error.";
        return { ok: false, error: message };
    }
    finally {
        clearTimeout(timer);
    }
};
/**
 * Forward a fulfillment to its supplier.
 *
 * Called when an operator marks a slice `forwarded`. On success the status is
 * `forwarded`; on any delivery failure the status becomes `failed` with the
 * reason in `last_error`, so the console shows plainly that the supplier was
 * *not* reached — marking it "forwarded" when nothing was delivered would be a
 * lie an operator would act on.
 *
 * The forward is idempotent from the supplier's side via `forwardedReference`,
 * which is minted once and reused on every retry.
 */
export const forwardFulfillment = async (fulfillmentId) => {
    const [row] = await db
        .select({ f: orderFulfillments, s: suppliers, order: orders })
        .from(orderFulfillments)
        .leftJoin(suppliers, eq(orderFulfillments.supplierId, suppliers.id))
        .innerJoin(orders, eq(orderFulfillments.orderId, orders.id))
        .where(eq(orderFulfillments.id, fulfillmentId))
        .limit(1);
    if (!row)
        return { ok: false, via: "none", error: "Fulfillment not found." };
    if (!row.s) {
        await recordForward(fulfillmentId, "failed", "This slice has no supplier assigned.");
        return { ok: false, via: "none", error: "No supplier assigned." };
    }
    const supplier = row.s;
    const order = row.order;
    const reference = row.f.forwardedReference ?? randomToken(16);
    // NOTE: order lines are not attributed to individual fulfillments in the
    // schema, so a multi-supplier order sends each supplier the whole line set.
    // Splitting per supplier needs a fulfillment_id on order_items; tracked as a
    // follow-up rather than special-cased here.
    const lines = await db
        .select({ name: orderItems.productName, quantity: orderItems.quantity, variantId: orderItems.variantId })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
    const shipTo = [
        order.shippingName,
        order.shippingLine1,
        order.shippingLine2,
        `${order.shippingCity} ${order.shippingPostalCode}`,
        order.shippingCountry,
        order.shippingPhone,
    ]
        .filter(Boolean)
        .join("\n");
    const callbackUrl = `${env.apiPublicUrl}/api/supplier/fulfillments/${fulfillmentId}`;
    const po = {
        supplierName: supplier.name,
        orderNumber: order.orderNumber,
        reference,
        items: lines.map((l) => ({ name: l.name, sku: l.variantId, quantity: l.quantity })),
        shipTo,
        callbackUrl,
        token: reference,
    };
    // The structured body for webhook/api suppliers mirrors the email contents.
    const payload = {
        type: "purchase_order",
        reference,
        orderNumber: order.orderNumber,
        currency: order.currency,
        items: po.items,
        shipTo: {
            name: order.shippingName,
            line1: order.shippingLine1,
            line2: order.shippingLine2,
            city: order.shippingCity,
            postalCode: order.shippingPostalCode,
            country: order.shippingCountry,
            phone: order.shippingPhone,
        },
        callbackUrl,
        token: reference,
    };
    let via = supplier.channel;
    let result;
    if (supplier.channel === "email") {
        const delivered = await sendSupplierPurchaseOrder(supplier.contactEmail, po);
        result = delivered
            ? { ok: true }
            : { ok: false, error: "Email could not be sent (check SMTP configuration)." };
    }
    else {
        result = await postToSupplier(supplier.endpoint, payload, supplier.endpointSecret);
        via = supplier.channel;
    }
    await recordForward(fulfillmentId, result.ok ? "forwarded" : "failed", result.ok ? null : (result.error ?? "Forward failed"), reference);
    if (result.ok) {
        logger.info({ fulfillmentId, via, supplierId: supplier.id }, "fulfillment forwarded to supplier");
        return { ok: true, via };
    }
    logger.warn({ fulfillmentId, via, error: result.error }, "fulfillment forward failed");
    return { ok: false, via, error: result.error };
};
/** Persist the outcome of a forward attempt: status, attempts, error, reference. */
const recordForward = async (fulfillmentId, status, error, reference) => {
    await db
        .update(orderFulfillments)
        .set({
        status,
        lastError: error,
        attempts: sqlIncrement(),
        ...(reference ? { forwardedReference: reference } : {}),
        ...(status === "forwarded" ? { forwardedAt: new Date() } : {}),
    })
        .where(eq(orderFulfillments.id, fulfillmentId));
};
/** `attempts = attempts + 1`, written once and shared by every write site. */
const sqlIncrement = () => sql `${orderFulfillments.attempts} + 1`;
/**
 * Apply a supplier's status report.
 *
 * Authenticated by the per-fulfillment `forwardedReference` the supplier was
 * given, presented as `X-EDM-Token`. That value is opaque and unique, so
 * possession proves the caller is the supplier we forwarded to — no shared
 * global secret and no exposed order id to guess.
 *
 * The customer is emailed on `shipped` (with the tracking number) and on
 * `delivered`; a `failed` report is an internal operations problem — it sets
 * `last_error` for the console and does not tell the customer anything the store
 * has not decided how to resolve yet.
 */
export const applySupplierCallback = async (fulfillmentId, token, input) => {
    const [row] = await db
        .select({
        f: orderFulfillments,
        orderNumber: orders.orderNumber,
        guestEmail: orders.guestEmail,
        userId: orders.userId,
    })
        .from(orderFulfillments)
        .innerJoin(orders, eq(orderFulfillments.orderId, orders.id))
        .where(eq(orderFulfillments.id, fulfillmentId))
        .limit(1);
    if (!row)
        throw new AppError(404, "not_found", "Fulfillment not found.");
    if (!row.f.forwardedReference || !token || !safeEqual(row.f.forwardedReference, token)) {
        throw new AppError(401, "unauthorized", "Invalid or missing supplier token.");
    }
    const now = new Date();
    await db
        .update(orderFulfillments)
        .set({
        status: input.status,
        ...(input.trackingNumber !== undefined ? { trackingNumber: input.trackingNumber || null } : {}),
        ...(input.trackingCarrier !== undefined ? { trackingCarrier: input.trackingCarrier || null } : {}),
        ...(input.status === "shipped" ? { shippedAt: now } : {}),
        ...(input.status === "delivered" ? { deliveredAt: now } : {}),
        lastError: input.status === "failed" ? (input.note ?? "Supplier reported a failure.") : row.f.lastError,
    })
        .where(eq(orderFulfillments.id, fulfillmentId));
    if (input.status === "failed") {
        logger.warn({ fulfillmentId, note: input.note }, "supplier reported a fulfillment failure");
        return;
    }
    const to = await resolveCustomerEmail(row.guestEmail, row.userId);
    if (!to)
        return;
    if (input.status === "shipped" && input.trackingNumber) {
        void sendShippingUpdate(to, row.orderNumber, input.trackingCarrier ?? null, input.trackingNumber).catch((error) => logger.error({ err: error, fulfillmentId }, "failed to email shipping update"));
    }
    else if (input.status === "delivered") {
        void sendDeliveredUpdate(to, row.orderNumber).catch((error) => logger.error({ err: error, fulfillmentId }, "failed to email delivery update"));
    }
};
/** A guest order carries its own email; an account order resolves through users. */
const resolveCustomerEmail = async (guestEmail, userId) => {
    if (guestEmail)
        return guestEmail;
    if (!userId)
        return null;
    const [account] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return account?.email ?? null;
};
//# sourceMappingURL=forward.service.js.map