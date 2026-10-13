import { and, asc, avg, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { productVariants, products, reviews, users, wishlistItems, } from "../../db/schema.js";
import { badRequest, isDuplicateEntry, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { discountPercent } from "../../lib/money.js";
import { LIKE_ESCAPE, likeContains } from "../../lib/like.js";
/**
 * `rating_milli` is stored as an integer to keep the aggregate exact; dividing at
 * the edge avoids float drift across thousands of reviews.
 */
const ratingToFloat = (milli) => milli / 1000;
const toVariantView = (variant, product) => {
    const effectivePriceCents = variant.unitPriceCents ?? product.unitPriceCents;
    return {
        id: variant.id,
        sku: variant.sku,
        colorName: variant.colorName,
        colorValue: variant.colorValue,
        size: variant.size,
        stockOnHand: variant.stockOnHand,
        isBackorderable: variant.isBackorderable,
        // A back-orderable line is always purchasable regardless of the count.
        inStock: variant.isBackorderable || variant.stockOnHand > 0,
        effectivePriceCents,
    };
};
/**
 * Build the summary shape from a product row plus the two aggregates that cannot
 * be derived from it: whether any variant is purchasable, and (for the signed-in
 * case) whether the product is wishlisted.
 */
const toSummary = (product, inStock, isWishlisted = false) => ({
    id: product.id,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    category: product.category,
    gender: product.gender,
    subcategory: product.subcategory,
    badge: product.badge,
    unitPriceCents: product.unitPriceCents,
    compareAtCents: product.compareAtCents,
    discountPercent: discountPercent(product.unitPriceCents, product.compareAtCents),
    rating: ratingToFloat(product.rating),
    reviewCount: product.reviewCount,
    inStock,
    isWishlisted,
});
/**
 * In-stock state for a set of products, in one round trip.
 *
 * "In stock" means *some* variant is purchasable, so a product with one sold-out
 * size still shows as available rather than disappearing from the grid. Uses a
 * LEFT JOIN plus GROUP BY rather than N+1 lookups.
 */
const purchasableProductIds = async (productIds) => {
    if (productIds.length === 0)
        return new Set();
    const rows = await db
        .select({ productId: productVariants.productId })
        .from(productVariants)
        .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true), sql `(${productVariants.isBackorderable} = 1 OR ${productVariants.stockOnHand} > 0)`))
        .groupBy(productVariants.productId);
    return new Set(rows.map((r) => r.productId));
};
/** Wishlisted product ids for a user, scoped so a guest query cannot be built. */
const wishlistedProductIds = async (userId) => {
    const rows = await db
        .select({ productId: wishlistItems.productId })
        .from(wishlistItems)
        .where(eq(wishlistItems.userId, userId));
    return new Set(rows.map((r) => r.productId));
};
/**
 * Enrich raw product rows into summaries, resolving in-stock and wishlist state
 * in two batched queries.
 *
 * Exported because several call sites need the exact same derivation — the
 * catalogue grid, product detail, related products and the wishlist. Sharing one
 * implementation is what guarantees a product shows identical price, stock and
 * discount on every screen.
 */
export const buildSummaries = async (rows, userId) => {
    const [stockIds, wishIds] = await Promise.all([
        purchasableProductIds(rows.map((r) => r.id)),
        userId ? wishlistedProductIds(userId) : Promise.resolve(new Set()),
    ]);
    return rows.map((row) => toSummary(row, stockIds.has(row.id), wishIds.has(row.id)));
};
export const listProducts = async (filters, userId) => {
    const where = [eq(products.isActive, true)];
    if (filters.category)
        where.push(eq(products.category, filters.category));
    if (filters.gender)
        where.push(eq(products.gender, filters.gender));
    if (filters.subcategory)
        where.push(eq(products.subcategory, filters.subcategory));
    if (filters.badge)
        where.push(eq(products.badge, filters.badge));
    if (filters.minPriceCents !== undefined)
        where.push(sql `${products.unitPriceCents} >= ${filters.minPriceCents}`);
    if (filters.maxPriceCents !== undefined)
        where.push(sql `${products.unitPriceCents} <= ${filters.maxPriceCents}`);
    if (filters.inStock) {
        // EXISTS rather than a JOIN + DISTINCT: a product with several purchasable
        // variants must appear once, and a join would duplicate rows and corrupt the
        // page count. Mirrors the predicate used by `purchasableProductIds`.
        where.push(sql `EXISTS (
      SELECT 1 FROM ${productVariants} pv
      WHERE pv.product_id = ${products.id}
        AND pv.is_active = 1
        AND (pv.is_backorderable = 1 OR pv.stock_on_hand > 0)
    )`);
    }
    if (filters.search) {
        // Bound parameter, so a search term containing quotes or % cannot break out
        // of the LIKE and cannot be used to enumerate the table. LIKE metacharacters
        // inside the term are escaped by `likeContains`, which also picks the escape
        // character — see lib/like.ts for why it must not be a backslash.
        //
        // The escape character is interpolated WITHOUT surrounding quotes: it is a
        // bound parameter, so the driver already quotes it. Writing `ESCAPE '${...}'`
        // emits `''!''` and MySQL rejects it as a syntax error.
        const term = likeContains(filters.search);
        where.push(sql `(${products.name} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${products.brand} LIKE ${term} ESCAPE ${LIKE_ESCAPE} OR ${products.description} LIKE ${term} ESCAPE ${LIKE_ESCAPE})`);
    }
    const orderBy = {
        newest: [desc(products.createdAt)],
        price_asc: [asc(products.unitPriceCents)],
        price_desc: [desc(products.unitPriceCents)],
        rating: [desc(products.rating), desc(products.reviewCount)],
        name_asc: [asc(products.name)],
    }[filters.sort ?? "newest"];
    // Count and page share the same predicate so page totals cannot disagree with
    // the returned rows.
    const countRows = await db
        .select({ total: count() })
        .from(products)
        .where(and(...where));
    // COUNT() is BIGINT in MySQL, which the driver may hand back as a string
    // depending on the connection's bigNumberStrings setting.
    const total = Number(countRows[0]?.total ?? 0);
    const rows = await db
        .select()
        .from(products)
        .where(and(...where))
        .orderBy(...orderBy)
        .limit(filters.pageSize)
        .offset((filters.page - 1) * filters.pageSize);
    return {
        items: await buildSummaries(rows, userId),
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    };
};
/**
 * Fetch one product by slug.
 *
 * `isWishlisted` is only consulted when a user id is supplied — there is no
 * anonymous variant of the wishlist, so the field is simply false for guests
 * rather than leaking any cross-user state.
 */
export const getProductBySlug = async (slug, userId) => {
    const [product] = await db.select().from(products).where(eq(products.slug, slug)).limit(1);
    if (!product || !product.isActive) {
        // Same error for "does not exist" and "is retired": a 403-vs-404 split would
        // confirm the existence of unpublished products.
        throw notFound("Product not found.");
    }
    const [variants, wishIds] = await Promise.all([
        db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.productId, product.id), eq(productVariants.isActive, true)))
            .orderBy(asc(productVariants.size), asc(productVariants.colorName)),
        userId ? wishlistedProductIds(userId) : Promise.resolve(new Set()),
    ]);
    const stockIds = await purchasableProductIds([product.id]);
    return {
        ...toSummary(product, stockIds.has(product.id), wishIds.has(product.id)),
        gallery: product.gallery,
        description: product.description,
        specs: product.specs,
        variants: variants.map((v) => toVariantView(v, product)),
    };
};
/**
 * Filter options for the sidebar, derived from live data rather than hardcoded.
 *
 * The database returns one row per distinct (category, gender, subcategory)
 * tuple, which is the right shape for counting but the wrong shape for a UI: a
 * sidebar needs a de-duplicated list per facet, with counts summed across the
 * other dimensions so the numbers still mean "how many products would I get if
 * I picked this and nothing else".
 *
 * Facets with a null value are dropped — a missing subcategory is not a filter
 * a shopper can meaningfully click, and it cannot be sent as a query value.
 */
export const listFacets = async () => {
    const rows = await db
        .select({
        category: products.category,
        gender: products.gender,
        subcategory: products.subcategory,
        n: count(),
    })
        .from(products)
        .where(eq(products.isActive, true))
        .groupBy(products.category, products.gender, products.subcategory);
    const sum = (counts) => counts.reduce((a, b) => a + b, 0);
    const categories = new Map();
    const genders = new Map();
    // Keyed by `${category} ${subcategory}`: the same subcategory name can
    // legitimately appear under two categories and must stay separate.
    const subcategories = new Map();
    for (const row of rows) {
        const n = Number(row.n);
        categories.set(row.category, (categories.get(row.category) ?? 0) + n);
        if (row.gender)
            genders.set(row.gender, (genders.get(row.gender) ?? 0) + n);
        if (row.subcategory) {
            const key = `${row.category} ${row.subcategory}`;
            const existing = subcategories.get(key);
            if (existing)
                existing.count += n;
            else
                subcategories.set(key, { value: row.subcategory, category: row.category, count: n });
        }
    }
    const byCount = (a, b) => b.count - a.count;
    return {
        categories: [...categories.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => a.value.localeCompare(b.value)),
        genders: [...genders.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort(byCount),
        subcategories: [...subcategories.values()].sort((a, b) => a.category.localeCompare(b.category) || byCount(a, b)),
        total: sum([...categories.values()]),
    };
};
/**
 * Products sharing a category, excluding the one being viewed. Ranked by rating
 * so the "you may also like" block is stable and relevant rather than arbitrary.
 */
export const getRelatedProducts = async (productId, limit = 4, userId) => {
    const [product] = await db
        .select({ id: products.id, category: products.category })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);
    if (!product)
        return [];
    const rows = await db
        .select()
        .from(products)
        .where(and(eq(products.isActive, true), eq(products.category, product.category), sql `${products.id} <> ${productId}`))
        .orderBy(desc(products.rating), desc(products.reviewCount))
        .limit(limit);
    return buildSummaries(rows, userId);
};
/**
 * Public reviews only. Approval is enforced in the WHERE clause rather than in
 * application code, so an unapproved row cannot leak through a forgotten filter.
 */
export const listReviews = async (productId, limit = 20) => {
    const rows = await db
        .select({
        id: reviews.id,
        rating: reviews.rating,
        title: reviews.title,
        body: reviews.body,
        createdAt: reviews.createdAt,
        authorName: sql `COALESCE(${users.name}, 'Anonymous')`,
    })
        .from(reviews)
        .innerJoin(users, eq(reviews.userId, users.id))
        .where(and(eq(reviews.productId, productId), eq(reviews.isApproved, true)))
        .orderBy(desc(reviews.createdAt))
        .limit(limit);
    return rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        authorName: r.authorName,
        createdAt: r.createdAt.toISOString(),
    }));
};
/**
 * Recompute a product's denormalised rating from its approved reviews.
 *
 * Runs on the transaction handle so it sees the same snapshot as the write that
 * changed the approved set. Called after every insert and every moderation
 * decision — the aggregate is only correct if nothing can change the set without
 * also refreshing it.
 */
const recomputeRating = async (tx, productId) => {
    const aggRows = await tx
        .select({ mean: avg(reviews.rating), n: count() })
        .from(reviews)
        .where(and(eq(reviews.productId, productId), eq(reviews.isApproved, true)));
    // Rounded to the stored milli scale so the value is stable and comparable.
    const mean = Number(aggRows[0]?.mean ?? 0);
    const ratingMilli = Math.round(mean * 1000);
    const reviewCount = Number(aggRows[0]?.n ?? 0);
    await tx.update(products).set({ rating: ratingMilli, reviewCount }).where(eq(products.id, productId));
};
/**
 * Create a review and recompute the product aggregate in the same transaction.
 *
 * The row is created unapproved. That is the whole point of the moderation gate:
 * a review that nobody has read cannot move the public rating, so the aggregate
 * below is computed over approved rows only and is therefore unchanged by this
 * insert.
 *
 * The unique index on (productId, userId) is the real guarantee against double
 * reviews under concurrent requests; the pre-check only yields a friendlier
 * message in the non-racing case.
 */
export const createReview = async (productId, userId, input) => {
    const id = newId();
    await db.transaction(async (tx) => {
        // Cheap pre-check for the common, non-racing case so the caller gets a clear
        // message without a failed insert. Deliberately NOT a `SELECT ... FOR UPDATE`:
        // locking a row that does not exist yet takes a gap lock that can deadlock
        // against the very concurrent insert it was meant to guard.
        const [existing] = await tx
            .select({ id: reviews.id })
            .from(reviews)
            .where(and(eq(reviews.productId, productId), eq(reviews.userId, userId)))
            .limit(1);
        if (existing)
            throw badRequest("You have already reviewed this product.");
        // The unique index on (product_id, user_id) is the real guarantee under a
        // race: two simultaneous first-reviews both clear the pre-check, and the
        // second insert loses on the index. Catching it turns that into the same
        // error instead of an unhandled 500.
        try {
            await tx.insert(reviews).values({ id, productId, userId, ...input, isApproved: false });
        }
        catch (error) {
            if (isDuplicateEntry(error))
                throw badRequest("You have already reviewed this product.");
            throw error;
        }
        await recomputeRating(tx, productId);
    });
};
/**
 * The moderation queue.
 *
 * Filtered in SQL by `status` rather than by slicing after the fact, so the
 * pending count in the console nav matches the rows actually returned even when
 * the table is large.
 */
export const listReviewsForModeration = async (status, limit = 100) => {
    const rows = await db
        .select({
        id: reviews.id,
        productId: reviews.productId,
        productName: products.name,
        productSlug: products.slug,
        rating: reviews.rating,
        title: reviews.title,
        body: reviews.body,
        authorName: sql `COALESCE(${users.name}, 'Anonymous')`,
        isApproved: reviews.isApproved,
        createdAt: reviews.createdAt,
        moderatedAt: reviews.moderatedAt,
    })
        .from(reviews)
        .innerJoin(users, eq(reviews.userId, users.id))
        .innerJoin(products, eq(reviews.productId, products.id))
        .where(status === "pending" ? eq(reviews.isApproved, false) : undefined)
        .orderBy(desc(reviews.createdAt))
        .limit(limit);
    return rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: r.productName,
        productSlug: r.productSlug,
        rating: r.rating,
        title: r.title,
        body: r.body,
        authorName: r.authorName,
        isApproved: r.isApproved,
        createdAt: r.createdAt.toISOString(),
        moderatedAt: r.moderatedAt?.toISOString() ?? null,
    }));
};
/**
 * Approve or reject a review.
 *
 * Approving makes it public, so the product's rating aggregate has to move with
 * it — hence the recompute in the same transaction as the flag. Rejecting does
 * not restock anything, but it does remove the review from the aggregate if it
 * had previously been approved, which is why the recompute runs on both paths
 * rather than only on approval.
 *
 * The decision is recorded against `moderated_by`/`moderated_at`. Approval with
 * no audit trail means a bad review can be published with no way to establish
 * afterwards who let it through.
 *
 * Idempotent: re-approving an approved review is a no-op apart from refreshing
 * the moderator stamp, so a double-click cannot double-count.
 */
export const moderateReview = async (reviewId, approved, adminId) => {
    await db.transaction(async (tx) => {
        const [review] = await tx
            .select({ id: reviews.id, productId: reviews.productId, isApproved: reviews.isApproved })
            .from(reviews)
            .where(eq(reviews.id, reviewId))
            .for("update")
            .limit(1);
        if (!review)
            throw notFound("Review not found.");
        if (review.isApproved !== approved) {
            await tx
                .update(reviews)
                .set({ isApproved: approved, moderatedBy: adminId, moderatedAt: new Date() })
                .where(eq(reviews.id, reviewId));
            await recomputeRating(tx, review.productId);
        }
        else {
            // Same decision as already recorded. Still stamp the moderator so the audit
            // trail reflects who last looked, but leave the aggregate alone.
            await tx
                .update(reviews)
                .set({ moderatedBy: adminId, moderatedAt: new Date() })
                .where(eq(reviews.id, reviewId));
        }
    });
    // Fetched by id directly rather than scanning `listReviewsForModeration`. That
    // scan is capped at 500 rows and ordered newest-first, so moderating a review
    // older than the newest 500 would have succeeded in the update above and then
    // reported 404 — a phantom failure on a change that actually took effect.
    const [row] = await db
        .select({
        id: reviews.id,
        productId: reviews.productId,
        productName: products.name,
        productSlug: products.slug,
        rating: reviews.rating,
        title: reviews.title,
        body: reviews.body,
        authorName: sql `COALESCE(${users.name}, 'Anonymous')`,
        isApproved: reviews.isApproved,
        createdAt: reviews.createdAt,
        moderatedAt: reviews.moderatedAt,
    })
        .from(reviews)
        .innerJoin(users, eq(reviews.userId, users.id))
        .innerJoin(products, eq(reviews.productId, products.id))
        .where(eq(reviews.id, reviewId))
        .limit(1);
    if (!row)
        throw notFound("Review not found.");
    return {
        id: row.id,
        productId: row.productId,
        productName: row.productName,
        productSlug: row.productSlug,
        rating: row.rating,
        title: row.title,
        body: row.body,
        authorName: row.authorName,
        isApproved: row.isApproved,
        createdAt: row.createdAt.toISOString(),
        moderatedAt: row.moderatedAt?.toISOString() ?? null,
    };
};
//# sourceMappingURL=catalog.service.js.map