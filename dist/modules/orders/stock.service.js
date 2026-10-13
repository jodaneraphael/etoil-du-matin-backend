import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orderItems, orders, productVariants } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
/**
 * Stock reservations.
 *
 * Checkout decrements `product_variants.stock_on_hand` inside the order's own
 * transaction, before the card is charged. That is a *reservation*, not a sale:
 * the order is still `pending_payment` and may yet be abandoned. Without a way to
 * undo it, every abandoned basket permanently removes units from the catalogue
 * and a sold-out product can never be bought again.
 *
 * Releasing has one hard requirement: it must happen exactly once per order. The
 * same order can be cancelled from three directions — the payment provider
 * cancelling the intent, an operator cancelling it from the admin console, and
 * the expiry sweep noticing it was never paid — and any two of those can run at
 * once. A release that ran twice would credit the same units back twice, letting
 * more items be sold than exist.
 *
 * `orders.stock_released_at` is the guard. It is written by the same conditional
 * UPDATE that performs the release, so the claim and the restock are one atomic
 * step: the caller who clears the column owns the restock, and everyone else is
 * told the release already happened.
 */
/** Order states in which the stock is genuinely sold and must never be returned. */
const SOLD_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);
/**
 * Release stock for an order without changing its status.
 *
 * Used when payment initialization fails (e.g., Stripe API error) and we need
 * to return the reserved stock but keep the order for potential retry.
 * The order remains in its current state (typically pending_payment).
 */
export const releaseStock = async (orderId) => {
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
        const [claimed] = await tx
            .update(orders)
            .set({ stockReleasedAt: now })
            .where(and(eq(orders.id, orderId), isNull(orders.stockReleasedAt)));
        if ((claimed?.affectedRows ?? 0) === 0) {
            return { released: false, units: 0 };
        }
        const [order] = await tx
            .select({ status: orders.status })
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);
        if (!order) {
            return { released: false, units: 0 };
        }
        // Don't release stock for already paid orders
        if (SOLD_STATUSES.has(order.status)) {
            await tx.update(orders).set({ stockReleasedAt: null }).where(eq(orders.id, orderId));
            return { released: false, units: 0 };
        }
        const lines = await tx
            .select({ allocations: orderItems.variantAllocations })
            .from(orderItems)
            .where(eq(orderItems.orderId, orderId));
        const perVariant = new Map();
        for (const line of lines) {
            for (const allocation of line.allocations ?? []) {
                perVariant.set(allocation.variantId, (perVariant.get(allocation.variantId) ?? 0) + allocation.quantity);
            }
        }
        let units = 0;
        for (const [variantId, quantity] of perVariant) {
            if (quantity <= 0)
                continue;
            await tx
                .update(productVariants)
                .set({ stockOnHand: sql `${productVariants.stockOnHand} + ${quantity}` })
                .where(eq(productVariants.id, variantId));
            units += quantity;
        }
        return { released: true, units };
    });
    if (outcome.released) {
        logger.info({ orderId, units: outcome.units }, "released stock due to payment initialization failure");
    }
    return { released: outcome.released, units: outcome.units };
};
/**
 * Cancel an unpaid order and hand its reserved stock back.
 *
 * The status transition and the release happen in one transaction, and the
 * conditional UPDATE that claims `stock_released_at` also takes the order's row
 * lock. That lock is what makes the subsequent status read trustworthy: a
 * concurrent `payment_intent.succeeded` cannot move the order to `paid` between
 * the claim and the read, so stock cannot be returned for an order that was paid
 * at the same moment.
 *
 * `reason` is recorded in the log only — the order keeps its `canceled` status
 * either way, because from the customer's point of view an expired checkout and
 * a cancelled one are the same thing.
 */
export const cancelAndReleaseStock = async (orderId, reason) => {
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
        /**
         * Claim the release. `stock_released_at IS NULL` is the entire guard, so this
         * UPDATE is the atomic test-and-set: a concurrent second caller updates zero
         * rows and stops here without restocking.
         */
        const [claimed] = await tx
            .update(orders)
            .set({ stockReleasedAt: now })
            .where(and(eq(orders.id, orderId), isNull(orders.stockReleasedAt)));
        if ((claimed?.affectedRows ?? 0) === 0) {
            return { released: false, units: 0 };
        }
        const [order] = await tx
            .select({ status: orders.status, orderNumber: orders.orderNumber })
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);
        if (!order) {
            return { released: false, units: 0 };
        }
        // Already paid, or paid and since refunded. The units are spoken for, so hand
        // the claim back and leave the order alone — a refund does not restock,
        // because the goods are on their way back rather than back on the shelf.
        if (SOLD_STATUSES.has(order.status)) {
            await tx.update(orders).set({ stockReleasedAt: null }).where(eq(orders.id, orderId));
            return { released: false, units: 0 };
        }
        const lines = await tx
            .select({ allocations: orderItems.variantAllocations })
            .from(orderItems)
            .where(eq(orderItems.orderId, orderId));
        /**
         * One order can touch the same variant from more than one line, so the
         * per-variant totals are accumulated first and applied once. Crediting each
         * allocation separately would work numerically but issues N statements where
         * N is the number of lines, and makes the restock harder to reason about when
         * auditing.
         */
        const perVariant = new Map();
        for (const line of lines) {
            // Older rows predate the column and read back as null; treat that as "this
            // line reserved nothing", which is exactly what it did.
            for (const allocation of line.allocations ?? []) {
                perVariant.set(allocation.variantId, (perVariant.get(allocation.variantId) ?? 0) + allocation.quantity);
            }
        }
        let units = 0;
        for (const [variantId, quantity] of perVariant) {
            if (quantity <= 0)
                continue;
            await tx
                .update(productVariants)
                .set({ stockOnHand: sql `${productVariants.stockOnHand} + ${quantity}` })
                .where(eq(productVariants.id, variantId));
            units += quantity;
        }
        /**
         * The order is written `canceled` only now, after the claim, so the two facts
         * ("stock is back" and "the order is closed") cannot be observed disagreeing.
         *
         * The status is overwritten rather than tested, because the claim above has
         * already locked the row and proved this order was still unpaid. Restricting
         * the write to `pending_payment`/`failed` with a status predicate would only
         * add a second chance to be wrong.
         */
        await tx.update(orders).set({ status: "canceled" }).where(eq(orders.id, orderId));
        return { released: true, units, orderNumber: order.orderNumber };
    });
    if (outcome.released) {
        logger.info({ orderId, orderNumber: outcome.orderNumber, units: outcome.units, reason }, "released stock held by an unpaid order");
    }
    return { released: outcome.released, units: outcome.units };
};
/**
 * Find orders that have been sitting unpaid for too long.
 *
 * Bounded and indexed by `created_at`, so the sweep stays cheap as the table
 * grows. The window is generous on purpose: the reservation has to outlast a
 * shopper who fills in the shipping form, waits for a 3-D Secure redirect, or
 * loses their connection mid-payment. Releasing early would let two shoppers
 * both pass an availability check for the last unit.
 */
export const findExpiredPendingOrders = async (olderThan, limit) => {
    const rows = await db
        .select({ id: orders.id, createdAt: orders.createdAt })
        .from(orders)
        .where(and(inArray(orders.status, ["pending_payment", "failed"]), isNull(orders.stockReleasedAt), sql `${orders.createdAt} <= ${olderThan}`))
        .orderBy(orders.createdAt)
        .limit(limit);
    return rows.map((row) => row.id);
};
/**
 * Cancel every expired unpaid order, one transaction each.
 *
 * A failure on one order must not abandon the rest of the batch, so each is
 * released independently and the error is logged and swallowed. The next sweep
 * retries whatever did not go through.
 */
export const releaseExpiredOrders = async (windowMs, limit) => {
    const cutoff = new Date(Date.now() - windowMs);
    const candidates = await findExpiredPendingOrders(cutoff, limit);
    let released = 0;
    for (const orderId of candidates) {
        try {
            const result = await cancelAndReleaseStock(orderId, "expired");
            if (result.released)
                released += 1;
        }
        catch (error) {
            logger.error({ err: error, orderId }, "failed to release an expired order");
        }
    }
    return released;
};
//# sourceMappingURL=stock.service.js.map