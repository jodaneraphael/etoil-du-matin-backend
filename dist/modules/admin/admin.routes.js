import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAdmin, requireAuth } from "../../middleware/auth.js";
import { readLimiter, writeLimiter } from "../../middleware/security.js";
import { asyncHandler, params, validatedBody, validatedQuery, validateRequest } from "../../middleware/validate.js";
import * as catalog from "../catalog/catalog.service.js";
import * as contact from "../contact/contact.service.js";
import { adminCustomerListQuerySchema, adminProductListQuerySchema, adminSupplierListQuerySchema, analyticsRangeSchema, contactListQuerySchema, contactStatusSchema, idSchema, lowStockQuerySchema, productAdminParamsSchema, productCreateSchema, productUpdateSchema, reviewModerationParamsSchema, reviewModerationQuerySchema, reviewModerationSchema, supplierCreateSchema, supplierParamsSchema, supplierUpdateSchema, } from "../schemas.js";
import * as admin from "./admin.service.js";
/**
 * Admin console endpoints for products, suppliers, customers and analytics.
 *
 * The whole router is behind `requireAuth` + `requireAdmin`, so the role is
 * re-read from the database on every request and a demotion takes effect
 * immediately rather than at token expiry. Order/fulfillment endpoints live in
 * `orders.routes.ts` and mount at `/api/admin/orders`.
 *
 * Static paths are registered before `/:id` so a slug can never be shadowed by
 * a parameterised sibling.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);
// ── Products ───────────────────────────────────────────────────────────────
adminRouter.get("/products", readLimiter, validateRequest({ query: adminProductListQuerySchema }), asyncHandler(async (_req, res) => {
    res.json(await admin.listAdminProducts(validatedQuery(res, adminProductListQuerySchema)));
}));
adminRouter.post("/products", writeLimiter, validateRequest({ body: productCreateSchema }), asyncHandler(async (req, res) => {
    res.status(201).json({ product: await admin.createProduct(validatedBody(req, productCreateSchema)) });
}));
adminRouter.get("/products/:id", readLimiter, validateRequest({ params: productAdminParamsSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, productAdminParamsSchema);
    res.json({ product: await admin.getAdminProduct(id) });
}));
adminRouter.patch("/products/:id", writeLimiter, validateRequest({ params: productAdminParamsSchema, body: productUpdateSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, productAdminParamsSchema);
    res.json({ product: await admin.updateProduct(id, validatedBody(req, productUpdateSchema)) });
}));
/**
 * Retire a product.
 *
 * This is a soft delete (see admin.service.ts): the row keeps its order history
 * and its FK relationships, it simply stops being served by the storefront.
 */
adminRouter.delete("/products/:id", writeLimiter, validateRequest({ params: productAdminParamsSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, productAdminParamsSchema);
    res.json({ product: await admin.archiveProduct(id) });
}));
// ── Suppliers ──────────────────────────────────────────────────────────────
adminRouter.get("/suppliers", readLimiter, validateRequest({ query: adminSupplierListQuerySchema }), asyncHandler(async (_req, res) => {
    res.json(await admin.listSuppliers(validatedQuery(res, adminSupplierListQuerySchema)));
}));
adminRouter.post("/suppliers", writeLimiter, validateRequest({ body: supplierCreateSchema }), asyncHandler(async (req, res) => {
    res.status(201).json({ supplier: await admin.createSupplier(validatedBody(req, supplierCreateSchema)) });
}));
adminRouter.patch("/suppliers/:id", writeLimiter, validateRequest({ params: supplierParamsSchema, body: supplierUpdateSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, supplierParamsSchema);
    res.json({ supplier: await admin.updateSupplier(id, validatedBody(req, supplierUpdateSchema)) });
}));
/** Retire a supplier. A hard delete is refused by the fulfillment FK. */
adminRouter.delete("/suppliers/:id", writeLimiter, validateRequest({ params: supplierParamsSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, supplierParamsSchema);
    res.json({ supplier: await admin.archiveSupplier(id) });
}));
// ── Customers ──────────────────────────────────────────────────────────────
adminRouter.get("/customers", readLimiter, validateRequest({ query: adminCustomerListQuerySchema }), asyncHandler(async (_req, res) => {
    res.json(await admin.listCustomers(validatedQuery(res, adminCustomerListQuerySchema)));
}));
// ── Analytics ──────────────────────────────────────────────────────────────
adminRouter.get("/analytics", readLimiter, validateRequest({ query: analyticsRangeSchema }), asyncHandler(async (_req, res) => {
    const { range } = validatedQuery(res, analyticsRangeSchema);
    res.json({ analytics: await admin.getAnalytics(range) });
}));
/**
 * Low-stock products, for the dashboard's inventory alerts.
 *
 * Aggregated in SQL so the widget stays one query no matter how large the
 * catalogue is, and limited server-side rather than after the fact.
 */
adminRouter.get("/low-stock", readLimiter, validateRequest({ query: lowStockQuerySchema }), asyncHandler(async (_req, res) => {
    res.json(await admin.listLowStock(validatedQuery(res, lowStockQuerySchema)));
}));
// ── Inbound: contact messages & newsletter ────────────────────────────────
const messageParamsSchema = z.object({ id: idSchema }).strict();
/**
 * Triage queue for the contact form.
 *
 * The `unread` count is returned on every list so the console nav badge needs no
 * second request and cannot drift out of step with the list on screen.
 */
adminRouter.get("/messages", readLimiter, validateRequest({ query: contactListQuerySchema }), asyncHandler(async (_req, res) => {
    const [messages, unread, subscribers] = await Promise.all([
        contact.listMessages(validatedQuery(res, contactListQuerySchema)),
        contact.countUnread(),
        contact.countSubscribers(),
    ]);
    res.json({ messages, unread, subscribers });
}));
adminRouter.patch("/messages/:id", writeLimiter, validateRequest({ params: messageParamsSchema, body: contactStatusSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, messageParamsSchema);
    const { status } = validatedBody(req, contactStatusSchema);
    await contact.setMessageStatus(id, status);
    res.json({ message: await contact.getMessage(id), unread: await contact.countUnread() });
}));
/**
 * The subscriber list.
 *
 * Read-only on purpose: unsubscribe is a customer action, not an operator one.
 * Exposing a delete here would make it trivially easy to remove someone from a
 * list they consented to, with no record that it ever happened.
 */
adminRouter.get("/newsletter", readLimiter, asyncHandler(async (_req, res) => {
    res.json({ subscribers: await contact.listSubscribers(500), total: await contact.countSubscribers() });
}));
// ── Review moderation ──────────────────────────────────────────────────────
/**
 * Review moderation queue.
 *
 * Every review is written unapproved and reaches the public product page only
 * after an operator approves it here, so without this endpoint reviews could be
 * submitted but never published.
 */
adminRouter.get("/reviews", readLimiter, validateRequest({ query: reviewModerationQuerySchema }), asyncHandler(async (_req, res) => {
    const { status, limit } = validatedQuery(res, reviewModerationQuerySchema);
    res.json({ reviews: await catalog.listReviewsForModeration(status, limit) });
}));
/**
 * Approve or reject one review.
 *
 * The product's rating aggregate moves in the same transaction as the flag, so a
 * storefront can never show a score that does not match the visible reviews.
 */
adminRouter.patch("/reviews/:id", writeLimiter, validateRequest({ params: reviewModerationParamsSchema, body: reviewModerationSchema }), asyncHandler(async (req, res) => {
    const { id } = params(req, reviewModerationParamsSchema);
    const { approved } = validatedBody(req, reviewModerationSchema);
    res.json({ review: await catalog.moderateReview(id, approved, currentUserId(req)) });
}));
//# sourceMappingURL=admin.routes.js.map