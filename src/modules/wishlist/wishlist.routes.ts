import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { writeLimiter } from "../../middleware/security.js";
import { asyncHandler, requireAuthContext, validateRequest } from "../../middleware/validate.js";
import { idSchema } from "../schemas.js";
import { z } from "zod";
import * as wishlist from "./wishlist.service.js";

/**
 * Wishlist endpoints. All require an account — there is no anonymous wishlist,
 * which keeps the table free of ownerless rows and removes any question of who
 * may read a given list.
 */
export const wishlistRouter = Router();

wishlistRouter.use(requireAuth);

const productParamsSchema = z.object({ productId: idSchema }).strict();

/** Idempotent add: returns 204 whether or not the product was already saved. */
wishlistRouter.post(
  "/:productId",
  writeLimiter,
  validateRequest({ params: productParamsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { productId } = req.params as unknown as { productId: string };
    await wishlist.addToWishlist(userId, productId);
    res.status(204).end();
  }),
);

/** Idempotent delete, for the same reason. */
wishlistRouter.delete(
  "/:productId",
  writeLimiter,
  validateRequest({ params: productParamsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { productId } = req.params as unknown as { productId: string };
    await wishlist.removeFromWishlist(userId, productId);
    res.status(204).end();
  }),
);

wishlistRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json({ products: await wishlist.listWishlist(userId) });
  }),
);
