import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { products, wishlistItems } from "../../db/schema.js";
import { isDuplicateEntry, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { buildSummaries } from "../catalog/catalog.service.js";
/**
 * Wishlist.
 *
 * Every statement is scoped by `userId` in the WHERE clause, so a request can
 * only ever reach its owner's rows. No call site accepts a wishlist id belonging
 * to another user, and authorisation is never a separate lookup that could be
 * forgotten.
 */
/**
 * Adding is idempotent — a second add of the same product is a no-op rather than
 * a 409. A double-click on a heart icon should not surface an error, and the
 * unique index still guarantees one row per pair under concurrent requests.
 */
export const addToWishlist = async (userId, productId) => {
    const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, productId), eq(products.isActive, true)))
        .limit(1);
    if (!product)
        throw notFound("Product not found.");
    try {
        await db.insert(wishlistItems).values({ id: newId(), userId, productId });
    }
    catch (error) {
        // Swallow only the duplicate-key case; anything else is a real fault.
        if (!isDuplicateEntry(error))
            throw error;
    }
};
/** Deleting is idempotent for the same reason. A missing row is not an error. */
export const removeFromWishlist = async (userId, productId) => {
    await db
        .delete(wishlistItems)
        .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.productId, productId)));
};
/**
 * Wishlist contents as full product summaries, so the page renders from the same
 * shape as the catalogue grid and cannot drift from it.
 *
 * Ids are collected in wishlist order, the products are fetched by id, and the
 * shared builder re-derives live price, stock and discount. A product that sold
 * out after being wishlisted therefore still shows correct stock, and a
 * deactivated product drops out instead of rendering as a dead link.
 */
export const listWishlist = async (userId) => {
    const rows = await db
        .select({ productId: wishlistItems.productId })
        .from(wishlistItems)
        .where(eq(wishlistItems.userId, userId))
        .orderBy(desc(wishlistItems.createdAt));
    if (rows.length === 0)
        return [];
    const ids = rows.map((r) => r.productId);
    const productRows = await db
        .select()
        .from(products)
        .where(and(eq(products.isActive, true), inArray(products.id, ids)));
    const summaries = await buildSummaries(productRows, userId);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    // Re-apply wishlist order. `inArray` does not preserve it, and the page is
    // expected to show the most recently added first.
    return ids
        .map((id) => byId.get(id))
        .filter((s) => s !== undefined);
};
//# sourceMappingURL=wishlist.service.js.map