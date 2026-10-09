import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { readLimiter, writeLimiter } from "../../middleware/security.js";
import { asyncHandler, requireAuthContext, validatedBody, params, validatedQuery, validateRequest } from "../../middleware/validate.js";
import { FULFILLMENT_STATUSES } from "../../db/schema.js";
import {
  emailSchema,
  fulfillmentUpdateSchema,
  idSchema,
  orderListQuerySchema,
  orderNumberSchema,
  orderParamsSchema,
  refundSchema,
} from "../schemas.js";
import * as orders from "./orders.service.js";
import { reconcileOrderPayment } from "../payments/webhook.service.js";

/**
 * Order endpoints, split by audience.
 *
 * `/orders/*` is the customer's own history. `/admin/orders/*` is the console
 * view and is behind `requireAdmin`, which re-reads the role from the database so
 * a demotion takes effect immediately rather than at token expiry.
 */
export const ordersRouter = Router();

ordersRouter.use(requireAuth, readLimiter);

/** The signed-in customer's order history. */
ordersRouter.get(
  "/",
  validateRequest({ query: orderListQuerySchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await orders.listMyOrders(userId, validatedQuery(res, orderListQuerySchema)));
  }),
);

/**
 * A single customer order.
 *
 * Scoped by user id in the query, so another customer's order number returns 404
 * rather than 403 and the endpoint cannot be used to probe which numbers exist.
 */
ordersRouter.get(
  "/:orderNumber",
  validateRequest({ params: orderParamsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { orderNumber } = req.params as unknown as { orderNumber: string };
    res.json({ order: await orders.getMyOrder(userId, orderNumber) });
  }),
);

// ── Guest order lookup ──────────────────────────────────────────────────────

export const guestOrdersRouter = Router();

/**
 * Guest order lookup.
 *
 * Anonymous, so possession of the order number is not sufficient: the requester
 * must also supply the email the order was placed with. Both are validated and
 * compared in constant time.
 */
const guestLookupSchema = z
  .object({
    email: emailSchema,
    orderNumber: orderNumberSchema,
  })
  .strict();

guestOrdersRouter.post(
  "/lookup",
  readLimiter,
  validateRequest({ body: guestLookupSchema }),
  asyncHandler(async (req, res) => {
    res.json(await orders.getGuestOrder(req.body.orderNumber, req.body.email));
  }),
);

/**
 * Claim a guest order into the signed-in account.
 *
 * Requires all three of: the order number, the email it was placed with, and the
 * claim token issued at checkout. The email alone is not enough — otherwise
 * anyone who knew a customer's email could take over their order history.
 */
const claimSchema = z
  .object({
    orderNumber: orderNumberSchema,
    email: emailSchema,
    claimToken: z.string().min(16).max(200),
  })
  .strict();

guestOrdersRouter.post(
  "/claim",
  requireAuth,
  writeLimiter,
  validateRequest({ body: claimSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await orders.claimGuestOrder(userId, req.body.orderNumber, req.body.email, req.body.claimToken));
  }),
);

/**
 * Reconcile an order's payment with Stripe.
 *
 * The confirmation page calls this while it polls, because the order only moves
 * to `paid` via the `payment_intent.succeeded` webhook — which cannot reach a
 * localhost backend, and whose secret here is a placeholder rather than a real
 * `whsec_…`. Without this, a genuinely-charged test payment sits on
 * "Confirming your payment…" indefinitely. It retrieves the intent from Stripe
 * and runs the same settlement the webhook runs, so it is safe to call
 * repeatedly and safe to race the webhook (the status write is guarded).
 *
 * Anonymous and idempotent: it can only ever settle an order whose intent Stripe
 * reports as `succeeded` for the exact stored amount, so it grants no access and
 * reveals nothing beyond the caller already holding the order number.
 */
const reconcileParamsSchema = z.object({ orderNumber: orderNumberSchema }).strict();

guestOrdersRouter.post(
  "/:orderNumber/reconcile",
  readLimiter,
  validateRequest({ params: reconcileParamsSchema }),
  asyncHandler(async (req, res) => {
    const { orderNumber } = req.params as unknown as { orderNumber: string };
    const status = await reconcileOrderPayment(orderNumber);
    res.json({ status });
  }),
);

// ── Admin ───────────────────────────────────────────────────────────────────

export const adminOrdersRouter = Router();

adminOrdersRouter.use(requireAuth, requireAdmin, readLimiter);

adminOrdersRouter.get(
  "/",
  validateRequest({ query: orderListQuerySchema }),
  asyncHandler(async (_req, res) => {
    res.json(await orders.listAllOrders(validatedQuery(res, orderListQuerySchema)));
  }),
);

/**
 * Fulfillment queue.
 *
 * Registered before `/:id` so the static path cannot be shadowed by the
 * parameterised one.
 *
 * The status is validated rather than cast: an unrecognised value must not be
 * interpolated into the query unchecked, and a typo should return a 422 that
 * names the allowed values instead of silently listing every row.
 */
const queueQuerySchema = z
  .object({ status: z.enum(FULFILLMENT_STATUSES).default("pending") })
  .strict();

adminOrdersRouter.get(
  "/fulfillments/queue",
  validateRequest({ query: queueQuerySchema }),
  asyncHandler(async (_req, res) => {
    const { status } = validatedQuery(res, queueQuerySchema);
    res.json({ fulfillments: await orders.listFulfillmentQueue(status) });
  }),
);

const orderByIdParamsSchema = z.object({ id: idSchema }).strict();

/**
 * Update a fulfillment's state, tracking details, or supplier assignment.
 *
 * `supplierId` is how an operator resolves a slice created with a NULL supplier
 * (a product that was never sourced): the update supplies a real id, which the
 * FK validates. The order is never re-derived from client input.
 */
const fulfillmentByIdParamsSchema = z.object({ id: idSchema }).strict();

adminOrdersRouter.patch(
  "/fulfillments/:id",
  writeLimiter,
  validateRequest({ params: fulfillmentByIdParamsSchema, body: fulfillmentUpdateSchema }),
  asyncHandler(async (req, res) => {
    const { id } = params(req, fulfillmentByIdParamsSchema);
    res.json({ fulfillment: await orders.updateFulfillment(id, validatedBody(req, fulfillmentUpdateSchema)) });
  }),
);

adminOrdersRouter.get(
  "/:id",
  validateRequest({ params: orderByIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const { id } = params(req, orderByIdParamsSchema);
    res.json({ order: await orders.getOrderByIdForAdmin(id) });
  }),
);

/**
 * Refund an order, in whole or in part.
 *
 * The Stripe call happens before the local rows are written, so a local failure
 * leaves the refund recorded at Stripe and visibly unreconciled rather than the
 * reverse. The amount is validated against the order by the service, not trusted
 * from the request beyond the refundSchema bounds.
 *
 * `idempotencyKey` must be generated once per refund dialog and reused on retry.
 * The console holds it in component state for exactly that reason: a retried
 * request has to look identical to Stripe, while a *second* refund of the same
 * amount must not.
 */
adminOrdersRouter.post(
  "/:id/refund",
  writeLimiter,
  validateRequest({ params: orderByIdParamsSchema, body: refundSchema }),
  asyncHandler(async (req, res) => {
    const { id } = params(req, orderByIdParamsSchema);
    const { amountCents, reason, idempotencyKey } = validatedBody(req, refundSchema);
    res.json(await orders.refundOrder(id, amountCents, reason, idempotencyKey));
  }),
);
