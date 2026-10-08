import { Router, raw } from "express";
import { env } from "../../env.js";
import { asyncHandler } from "../../middleware/validate.js";
import { logger } from "../../lib/logger.js";
import { processEvent, verifyEvent } from "./webhook.service.js";

/**
 * Stripe webhook endpoint.
 *
 * Mounted with its own raw body parser. `express.json()` cannot be used here
 * because Stripe signs the exact bytes it sent; once a JSON parser has
 * reserialised the payload, the signature can no longer be verified and every
 * event would be rejected. This is why the route must be registered *before* the
 * global `express.json()` in `app.ts`.
 */
export const webhookRouter = Router();

webhookRouter.post(
  "/stripe",
  // Cap the body so a malformed or hostile request cannot stream unbounded data
  // into memory before the signature check rejects it.
  raw({ type: "application/json", limit: "256kb" }),
  asyncHandler(async (req, res) => {
    let event;
    try {
      event = verifyEvent(req.body as Buffer, req.get("stripe-signature"));
    } catch (error) {
      // A bad signature is a rejected delivery, not a server fault. 400 tells
      // Stripe the payload will never be accepted, which stops pointless retries.
      // The reason is logged but never returned — echoing verification detail
      // would help an attacker probe the secret.
      logger.warn({ err: error, ip: req.ip }, "rejected stripe webhook with invalid signature");
      res.status(400).json({ error: { code: "invalid_signature", message: "Signature verification failed." } });
      return;
    }

    const outcome = await processEvent(event);

    // 200 for duplicates and ignored types so Stripe stops retrying. A genuine
    // processing failure throws and becomes a 500, which is what triggers a
    // retry.
    res.json({ received: true, outcome });
  }),
);

/**
 * Webhook setup helper for local development.
 *
 * Reads the signing secret Stripe would use. Kept server-side so the value is
 * never needed by a browser, and is only reachable with an admin token.
 */
export const describeWebhookConfig = () => ({
  url: `${env.apiPublicUrl}/api/webhooks/stripe`,
  events: [
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "payment_intent.canceled",
    "charge.refunded",
  ] as const,
});
