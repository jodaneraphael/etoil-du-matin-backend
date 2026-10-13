import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { cartItems, productVariants, products } from "../../db/schema.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { computeTotals, priceLine } from "../../lib/money.js";
const MAX_LINES = 50;
const MAX_UNITS_PER_LINE = 99;
const resolveLine = async (productSlug, variantId, quantity) => {
    const [product] = await db
        .select()
        .from(products)
        .where(and(eq(products.slug, productSlug), eq(products.isActive, true)))
        .limit(1);
    if (!product)
        return { error: `"${productSlug}" is no longer available.` };
    let variant;
    if (variantId) {
        const [row] = await db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.id, variantId), eq(productVariants.isActive, true)))
            .limit(1);
        // A variant that belongs to a *different* product is a malformed request,
        // not a sold-out size: the client is trying to pair a product with an
        // unrelated variant, which must not silently resolve to the other item.
        if (!row)
            return { error: "That option is no longer available." };
        if (row.productId !== product.id)
            return { error: "That option does not belong to this product." };
        variant = row;
    }
    const unitPriceCents = variant?.unitPriceCents ?? product.unitPriceCents;
    const stockOnHand = variant?.stockOnHand ?? 0;
    const isBackorderable = variant?.isBackorderable ?? false;
    // With no variant chosen the line represents the product itself, so the
    // available quantity is the sum across its active variants.
    const effectiveStock = variant
        ? stockOnHand
        : ((await db
            .select({ total: sql `COALESCE(SUM(${productVariants.stockOnHand}), 0)` })
            .from(productVariants)
            .where(and(eq(productVariants.productId, product.id), eq(productVariants.isActive, true))))[0]?.total ?? 0);
    const available = isBackorderable || effectiveStock >= quantity;
    return {
        line: {
            productId: product.id,
            productSlug: product.slug,
            variantId: variant?.id ?? null,
            name: product.name,
            variantLabel: variant ? [variant.colorName, variant.size].filter(Boolean).join(" / ") || null : null,
            imageUrl: product.imageUrl,
            sku: variant?.sku ?? product.slug,
            quantity,
            unitPriceCents,
            stockOnHand: effectiveStock,
            isBackorderable,
            purchasable: available,
            unavailableReason: available ? null : `Only ${effectiveStock} left in stock.`,
        },
    };
};
/**
 * Compute the line total. Aliased rather than reimplemented so `money.ts` stays
 * the single place line arithmetic is defined.
 */
const price = priceLine;
/**
 * Read the cart and price every line from live data.
 *
 * Rows are joined to products and variants in a single query, so a line whose
 * product has since been deactivated still appears in the response with an
 * explanation rather than making the whole request fail.
 */
export const getCart = async (userId) => {
    const rows = await db
        .select({ cart: cartItems, product: products, variant: productVariants })
        .from(cartItems)
        .innerJoin(products, eq(cartItems.productId, products.id))
        .leftJoin(productVariants, eq(cartItems.variantId, productVariants.id))
        .where(eq(cartItems.userId, userId))
        .orderBy(cartItems.createdAt);
    const lines = [];
    const issues = [];
    /**
     * Active stock for a line that names no variant, summed in one query.
     *
     * A variant-less line draws on the product's variants collectively, so its
     * available quantity is their total. Reporting 0 instead — the value the join
     * yields for a missing `variant` row — would mark every such line unpurchasable
     * and leave the shopper with a bag they cannot check out, even though
     * `resolveLine` and checkout both consider those lines buyable.
     *
     * Collected up front and reused, so a basket of many variant-less lines costs
     * one extra query rather than one per line.
     */
    const variantlessProductIds = [
        ...new Set(rows.filter((r) => r.cart.variantId === null).map((r) => r.product.id)),
    ];
    const aggregateRows = variantlessProductIds.length === 0
        ? []
        : await db
            .select({
            productId: productVariants.productId,
            total: sql `COALESCE(SUM(${productVariants.stockOnHand}), 0)`,
        })
            .from(productVariants)
            .where(and(inArray(productVariants.productId, variantlessProductIds), eq(productVariants.isActive, true)))
            .groupBy(productVariants.productId);
    const aggregateStock = new Map(aggregateRows.map((r) => [r.productId, Number(r.total)]));
    for (const row of rows) {
        const product = row.product;
        const variant = row.variant ?? undefined;
        if (!product.isActive) {
            issues.push({
                lineId: row.cart.id,
                productName: product.name,
                reason: "This product is no longer sold.",
            });
            continue;
        }
        /**
         * Variant withdrawn after it was added: keep the line but block it, so the
         * shopper can remove it deliberately rather than watching it vanish.
         *
         * Two distinct cases land here and both must block the line:
         *
         *   - the row is gone entirely, because `cart_items_variant_fk` cascades; and
         *   - the row is still present but `is_active = 0`, because an operator
         *     retired that size or colour without deleting it.
         *
         * Checking only for a missing join result treated the second case as
         * perfectly purchasable, so a retired variant sat in the bag looking buyable
         * and only failed at checkout.
         */
        if (row.cart.variantId && (!variant || !variant.isActive)) {
            issues.push({
                lineId: row.cart.id,
                productName: product.name,
                reason: variant ? "That option has been retired." : "That option is no longer available.",
            });
            continue;
        }
        const stockOnHand = variant ? variant.stockOnHand : (aggregateStock.get(product.id) ?? 0);
        const isBackorderable = variant?.isBackorderable ?? false;
        const requested = row.cart.quantity;
        const overSold = !isBackorderable && stockOnHand < requested;
        lines.push(price({
            lineId: row.cart.id,
            productId: product.id,
            productSlug: product.slug,
            variantId: variant?.id ?? null,
            name: product.name,
            variantLabel: variant ? [variant.colorName, variant.size].filter(Boolean).join(" / ") || null : null,
            imageUrl: product.imageUrl,
            sku: variant?.sku ?? product.slug,
            quantity: requested,
            unitPriceCents: variant?.unitPriceCents ?? product.unitPriceCents,
            stockOnHand,
            isBackorderable,
            purchasable: !overSold,
            unavailableReason: overSold ? `Only ${stockOnHand} left in stock.` : null,
        }));
    }
    return { lines, totals: computeTotals(lines), issues };
};
/**
 * Add a line, or increase an existing one.
 *
 * The increment is expressed as `quantity + <requested>` inside
 * `ON DUPLICATE KEY UPDATE`, so the database adds it atomically. The previous
 * implementation read the current quantity and then wrote `read + requested`;
 * two concurrent adds both read the same value and one of the two increments was
 * lost, so clicking "add" twice in quick succession could leave the bag with one
 * item instead of two.
 *
 * The write runs in a transaction that first takes a `FOR UPDATE` lock on the
 * user's existing lines. That serves two purposes: it serialises concurrent adds
 * for one shopper, and it makes the distinct-line ceiling countable rather than
 * advisory. Without the lock, two requests adding two *different* new lines both
 * observe 49 lines and both insert, leaving 51 against a limit of 50.
 */
export const addLine = async (userId, input) => {
    // Validate quantity before resolving
    if (input.quantity < 1 || input.quantity > MAX_UNITS_PER_LINE) {
        throw badRequest(`Quantity must be between 1 and ${MAX_UNITS_PER_LINE}.`);
    }
    const resolved = await resolveLine(input.productSlug, input.variantId, input.quantity);
    if ("error" in resolved)
        throw badRequest(resolved.error);
    const { line } = resolved;
    if (!line.purchasable)
        throw badRequest(line.unavailableReason ?? "That quantity is not available.");
    const { productId, variantId } = line;
    const added = Math.min(input.quantity, MAX_UNITS_PER_LINE);
    /**
     * The per-line ceiling is applied in SQL with `LEAST` for the same reason the
     * increment is: it cannot be sidesteped by racing a capped write against an
     * uncapped one. A client cannot walk past it by sending `quantity: 99` twice
     * either, because both requests clamp against the same running total.
     */
    await db.transaction(async (tx) => {
        // Locked in primary-key order for the same deadlock-avoidance reason as
        // checkout: a consistent global order across concurrent writers.
        await tx
            .select({ id: cartItems.id })
            .from(cartItems)
            .where(eq(cartItems.userId, userId))
            .orderBy(cartItems.id)
            .for("update");
        const [already] = await tx
            .select({ id: cartItems.id })
            .from(cartItems)
            .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, productId), 
        // MySQL's `= NULL` never matches, so an absent variant needs IS NULL.
        variantId ? eq(cartItems.variantId, variantId) : isNull(cartItems.variantId)))
            .limit(1);
        // Only a genuinely new line counts against the ceiling; growing an existing
        // one must not be refused because the bag happens to be full.
        if (!already) {
            const countRows = await tx
                .select({ n: sql `COUNT(*)` })
                .from(cartItems)
                .where(eq(cartItems.userId, userId));
            const count = countRows[0]?.n;
            if (count !== undefined && Number(count) >= MAX_LINES) {
                throw badRequest("Your bag is full. Remove an item before adding another.");
            }
        }
        await tx
            .insert(cartItems)
            .values({
            id: newId(),
            userId,
            productId,
            variantId: variantId ?? null,
            quantity: added,
        })
            .onDuplicateKeyUpdate({
            set: {
                quantity: sql `LEAST(${MAX_UNITS_PER_LINE}, ${cartItems.quantity} + ${added})`,
                updatedAt: new Date(),
            },
        });
    });
    return getCart(userId);
};
/** Set an exact quantity. Zero removes the line. */
export const setLineQuantity = async (userId, input) => {
    if (input.quantity === 0)
        return removeLine(userId, input);
    // Validate quantity before resolving
    if (input.quantity < 1 || input.quantity > MAX_UNITS_PER_LINE) {
        throw badRequest(`Quantity must be between 1 and ${MAX_UNITS_PER_LINE}.`);
    }
    const resolved = await resolveLine(input.productSlug, input.variantId, input.quantity);
    if ("error" in resolved)
        throw badRequest(resolved.error);
    const { line } = resolved;
    if (!line.purchasable)
        throw badRequest(line.unavailableReason ?? "That quantity is not available.");
    const updated = await db
        .update(cartItems)
        .set({ quantity: input.quantity })
        .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, line.productId), input.variantId ? eq(cartItems.variantId, input.variantId) : isNull(cartItems.variantId)));
    const affectedRows = updated[0]?.affectedRows;
    if (affectedRows === undefined || affectedRows === 0)
        throw notFound("That item is not in your bag.");
    return getCart(userId);
};
export const removeLine = async (userId, input) => {
    const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.slug, input.productSlug))
        .limit(1);
    if (!product)
        return getCart(userId);
    // Scoped by userId, so a caller cannot remove another shopper's line even if
    // they know the product and variant.
    await db
        .delete(cartItems)
        .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, product.id), input.variantId ? eq(cartItems.variantId, input.variantId) : isNull(cartItems.variantId)));
    return getCart(userId);
};
export const clearCart = async (userId) => {
    await db.delete(cartItems).where(eq(cartItems.userId, userId));
};
/**
 * Merge a guest cart into the account cart at sign-in.
 *
 * The whole merge runs in one transaction holding `FOR UPDATE` locks on the
 * account's existing lines. Two concurrent sign-ins on the same account would
 * otherwise each accumulate their own running total and one set of quantities
 * would be lost — the same failure the atomic `addLine` increment avoids, one
 * level up.
 *
 * Quantities are summed per line and re-capped, since the two carts could each be
 * at the per-line maximum. Uses ON DUPLICATE KEY UPDATE so the operation is
 * idempotent and cannot fail on the unique index under a retry.
 *
 * A line that no longer resolves, or that is not currently purchasable, is
 * dropped rather than failing the whole sign-in. The shopper still gets a usable
 * cart, and the discarded line is still visible in the guest cart the client
 * holds, so it is not silently lost from their point of view either.
 */
export const mergeIntoUserCart = async (userId, guestLines) => {
    if (guestLines.length === 0)
        return getCart(userId);
    await db.transaction(async (tx) => {
        // Locked in primary-key order for the same deadlock-avoidance reason as
        // `addLine`: one consistent order across all concurrent cart writers.
        await tx
            .select({ id: cartItems.id })
            .from(cartItems)
            .where(eq(cartItems.userId, userId))
            .orderBy(cartItems.id)
            .for("update");
        const existingCountRows = await tx
            .select({ n: sql `COUNT(*)` })
            .from(cartItems)
            .where(eq(cartItems.userId, userId));
        const countResult = existingCountRows[0]?.n;
        let lineCount = countResult !== undefined ? Number(countResult) : 0;
        for (const guestLine of guestLines.slice(0, MAX_LINES)) {
            const resolved = await resolveLine(guestLine.productSlug, guestLine.variantId, guestLine.quantity);
            if ("error" in resolved)
                continue;
            if (!resolved.line.purchasable)
                continue;
            // Does this line already exist on the account cart? Deciding that before the
            // insert is what lets the line-count ceiling distinguish "growing a line",
            // which is always allowed, from "adding a new one", which is not.
            const [already] = await tx
                .select({ id: cartItems.id })
                .from(cartItems)
                .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, resolved.line.productId), resolved.line.variantId
                ? eq(cartItems.variantId, resolved.line.variantId)
                : isNull(cartItems.variantId)))
                .limit(1);
            if (!already) {
                if (lineCount >= MAX_LINES)
                    continue;
                lineCount += 1;
            }
            const quantity = Math.min(guestLine.quantity, MAX_UNITS_PER_LINE);
            await tx
                .insert(cartItems)
                .values({
                id: newId(),
                userId,
                productId: resolved.line.productId,
                variantId: resolved.line.variantId,
                quantity,
            })
                .onDuplicateKeyUpdate({
                set: {
                    quantity: sql `LEAST(${MAX_UNITS_PER_LINE}, ${cartItems.quantity} + ${quantity})`,
                    updatedAt: new Date(),
                },
            });
        }
    });
    return getCart(userId);
};
//# sourceMappingURL=cart.service.js.map