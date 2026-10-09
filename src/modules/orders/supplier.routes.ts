import { Router } from "express";
import { z } from "zod";
import { writeLimiter } from "../../middleware/security.js";
import { asyncHandler, params, validateRequest, validatedBody } from "../../middleware/validate.js";
import { idSchema } from "../schemas.js";
import { applySupplierCallback } from "./forward.service.js";

/**
 * Supplier status callback.
 *
 * This is the inbound half of dropshipping: the supplier reports that a
 * fulfillment shipped, was delivered, or failed — so the order moves on without
 * an operator copying a tracking number out of an email. Server-to-server, so
 * there is no session; authentication is the per-fulfillment `forwardedReference`
 * the supplier was handed at forward time, presented as `X-EDM-Token` and
 * compared in constant time inside the service.
 *
 * Mounted under the ordinary JSON body parser (unlike the Stripe webhook, which
 * needs the raw bytes): the token is a header, not part of a signed body, so no
 * raw-body handling is required.
 */
export const supplierRouter = Router();

const callbackParams = z.object({ id: idSchema }).strict();

const callbackBody = z
  .object({
    status: z.enum(["shipped", "delivered", "failed"]),
    trackingNumber: z.string().trim().min(1).max(120).optional(),
    trackingCarrier: z.string().trim().min(1).max(80).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

supplierRouter.post(
  "/fulfillments/:id",
  writeLimiter,
  validateRequest({ params: callbackParams, body: callbackBody }),
  asyncHandler(async (req, res) => {
    const { id } = params(req, callbackParams);
    const token = req.header("x-edm-token") ?? undefined;
    await applySupplierCallback(id, token, validatedBody(req, callbackBody));
    res.json({ ok: true });
  }),
);
