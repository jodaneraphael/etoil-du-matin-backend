import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { writeLimiter } from "../../middleware/security.js";
import { asyncHandler, requireAuthContext, validateRequest } from "../../middleware/validate.js";
import { addToCartSchema, mergeCartSchema, removeFromCartSchema, updateCartLineSchema } from "../schemas.js";
import * as cart from "./cart.service.js";

/**
 * Cart endpoints.
 *
 * The cart lives server-side, keyed to an account, so it survives a device
 * change and the browser never becomes the authority on what is being bought.
 * Guests get a quote (see `checkout.routes`) rather than a persisted bag — a
 * server cart has no owner to attach to, and a shared guest cookie would leak
 * one shopper's contents to another on a shared machine.
 */
export const cartRouter = Router();

cartRouter.use(requireAuth);

/** Always returns the whole recalculated cart, so the client never has to sum. */
cartRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await cart.getCart(userId));
  }),
);

cartRouter.post(
  "/items",
  writeLimiter,
  validateRequest({ body: addToCartSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await cart.addLine(userId, req.body));
  }),
);

/**
 * Set an exact quantity. `quantity: 0` removes the line, so the quantity stepper
 * and the remove button can share one endpoint.
 */
cartRouter.patch(
  "/items",
  writeLimiter,
  validateRequest({ body: updateCartLineSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await cart.setLineQuantity(userId, req.body));
  }),
);

cartRouter.delete(
  "/items",
  writeLimiter,
  validateRequest({ body: removeFromCartSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await cart.removeLine(userId, req.body));
  }),
);

cartRouter.delete(
  "/",
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    await cart.clearCart(userId);
    res.status(204).end();
  }),
);

/**
 * Merge a guest bag into the account cart.
 *
 * A guest's basket lives only in the browser, so signing in has to hand it over
 * explicitly — without this route the bag a shopper filled before registering
 * simply vanished at the moment they created an account, which is the single most
 * common way a storefront loses a sale.
 *
 * The browser calls this after a successful sign-in, with whatever it had in local
 * storage. Nothing in the request is trusted: `mergeIntoUserCart` re-resolves
 * every line against live catalogue data, and a line that no longer resolves is
 * dropped rather than failing the whole sign-in.
 *
 * Idempotent by construction — quantities accumulate on the unique line index, so
 * a retried or double-fired merge cannot duplicate a line.
 */
cartRouter.post(
  "/merge",
  writeLimiter,
  validateRequest({ body: mergeCartSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json(await cart.mergeIntoUserCart(userId, req.body.lines));
  }),
);
