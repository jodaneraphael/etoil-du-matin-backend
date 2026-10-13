import { Router } from "express";
import { optionalAuth } from "../../middleware/auth.js";
import { asyncHandler, validatedQuery, validateRequest } from "../../middleware/validate.js";
import * as catalog from "./catalog.service.js";
import { productListQuerySchema, productParamsSchema, reviewCreateSchema } from "../schemas.js";
/**
 * Public catalogue endpoints.
 *
 * These are readable without a token, so they are mounted behind `optionalAuth`
 * rather than `requireAuth`: the response is identical for guests apart from the
 * `isWishlisted` flag, and requiring a token would make the storefront unusable
 * before sign-in.
 */
export const catalogRouter = Router();
catalogRouter.get("/products", optionalAuth, validateRequest({ query: productListQuerySchema }), asyncHandler(async (req, res) => {
    const filters = validatedQuery(res, productListQuerySchema);
    res.json(await catalog.listProducts(filters, req.auth?.userId));
}));
/** Filter options for the sidebar, derived from live data rather than hardcoded. */
catalogRouter.get("/facets", asyncHandler(async (_req, res) => {
    res.json({ facets: await catalog.listFacets() });
}));
/**
 * Product detail.
 *
 * Placed after `/products` so a slug can never be shadowed by a sibling static
 * path. `isActive` is enforced in the service, so a retired product reports 404
 * here exactly as a nonexistent one does.
 */
catalogRouter.get("/products/:slug", optionalAuth, validateRequest({ params: productParamsSchema }), asyncHandler(async (req, res) => {
    const { slug } = req.params;
    res.json({ product: await catalog.getProductBySlug(slug, req.auth?.userId) });
}));
catalogRouter.get("/products/:slug/related", optionalAuth, validateRequest({ params: productParamsSchema }), asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const product = await catalog.getProductBySlug(slug);
    res.json({ products: await catalog.getRelatedProducts(product.id, 4, req.auth?.userId) });
}));
/** Only approved reviews are ever returned. */
catalogRouter.get("/products/:slug/reviews", validateRequest({ params: productParamsSchema }), asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const product = await catalog.getProductBySlug(slug);
    res.json({ reviews: await catalog.listReviews(product.id) });
}));
/**
 * Submit a review. Requires an account — reviews are keyed by user id both for
 * the one-per-product uniqueness rule and to attribute the review.
 *
 * The row is created unapproved; `createReview` recomputes the product's rating
 * aggregate from approved rows only, so a pending review cannot move the score.
 */
catalogRouter.post("/products/:slug/reviews", optionalAuth, validateRequest({ params: productParamsSchema, body: reviewCreateSchema }), asyncHandler(async (req, res) => {
    if (!req.auth) {
        // Same 401 shape requireAuth would produce, so a guest client has one
        // code path to handle.
        res.status(401).json({ error: { code: "unauthorized", message: "Sign in to leave a review." } });
        return;
    }
    const { slug } = req.params;
    const product = await catalog.getProductBySlug(slug);
    await catalog.createReview(product.id, req.auth.userId, req.body);
    res.status(201).json({ review: { status: "pending_moderation" } });
}));
//# sourceMappingURL=catalog.routes.js.map