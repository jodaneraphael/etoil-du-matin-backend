import Stripe from "stripe";
import { env } from "../env.js";
import { AppError, serviceUnavailable } from "./errors.js";

/**
 * Stripe client.
 *
 * Created once at import time. Rotating the key requires a restart, which is the
 * right behaviour for a secret.
 *
 * `maxNetworkRetries` is deliberately 0. The SDK's automatic retry replays a
 * request on a network blip, which is correct for idempotent reads and dangerous
 * for payment creation — that is what the explicit idempotency keys on
 * `createPaymentIntent` are for, and the checkout path decides when to retry.
 */
export const stripe = new Stripe(env.stripeSecretKey, {
  // Pinned to the version this build was compiled against. Letting the SDK pick
  // its default would mean a library upgrade silently changing webhook payload
  // shapes and API behaviour in a deployed process.
  apiVersion: "2025-02-24.acacia",
  typescript: true,
  maxNetworkRetries: 0,
  telemetry: false,
  appInfo: { name: "etoil-du-matin", version: "1.0.0" },
});

/**
 * Translate a Stripe failure into the app's error taxonomy.
 *
 * A declined card is a 402 the client should surface verbatim; anything else is a
 * fault on our side or an outage at Stripe, and is reported as 503 so the client
 * offers "try again" rather than "your card was declined". The raw Stripe error
 * is attached as `cause` and logged, never returned to the caller.
 */
export const toPaymentError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof Stripe.errors.StripeCardError) {
    return new AppError(402, "payment_failed", error.message, { cause: error });
  }

  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return serviceUnavailable("Payments are busy. Please try again in a moment.");
  }

  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    // A malformed request is our bug, not the shopper's: report 500 rather than
    // letting a 402 or 400 imply their card or input was at fault.
    return new AppError(500, "payment_error", "The payment could not be started.", { cause: error });
  }

  return serviceUnavailable("Payments are temporarily unavailable. Please try again.");
};

/** Minor units, lower-cased ISO code — the shape Stripe expects. */
export const stripeAmount = (cents: number, currency: string) => ({
  amount: cents,
  currency: currency.toLowerCase(),
});
