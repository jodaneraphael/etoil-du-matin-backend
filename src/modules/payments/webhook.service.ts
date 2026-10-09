import type Stripe from "stripe";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orders, payments, webhookEvents } from "../../db/schema.js";
import { env } from "../../env.js";
import { newId } from "../../lib/ids.js";
import { isDuplicateEntry } from "../../lib/errors.js";
import { sendOrderConfirmation } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { stripe } from "../../lib/stripe.js";
import { cancelAndReleaseStock } from "../orders/stock.service.js";

/**
 * Stripe webhook handling.
 *
 * Webhooks are how an order becomes `paid`, so this is the trust boundary for
 * money. Four rules:
 *
 * 1. **The signature is verified before the payload is read.** `constructEvent`
 *    checks the HMAC over the exact raw bytes, so a body re-serialised by a JSON
 *    parser would fail the check. This is why the route is mounted with a raw
 *    body parser.
 * 2. **Every event is recorded, and the unique index on `stripe_event_id` makes
 *    processing idempotent.** Stripe delivers at least once; a duplicate must not
 *    move an order's state twice.
 * 3. **The amount is reconciled against the order.** A `payment_intent.succeeded`
 *    whose `amount_received` does not equal the order total is logged and treated
 *    as a fault, not as payment. Otherwise a partially-paid or tampered intent
 *    would mark a full-value order as settled.
 * 4. **No event type is trusted to mean what its name suggests.** Unknown types
 *    are recorded and acknowledged so Stripe stops retrying, rather than being
 *    treated as an error.
 */

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "failed";

/**
 * Verify and decode the event.
 *
 * Throws on a bad signature, which the route turns into a 400 — deliberately not
 * a 200, because a 400 is what tells Stripe the delivery was rejected rather than
 * merely unhandled.
 */
export const verifyEvent = (rawBody: Buffer, signature: string | undefined): Stripe.Event => {
  if (!signature) {
    throw new Error("Missing stripe-signature header.");
  }
  // The secret comes from the validated environment, never from `process.env`
  // directly — an unvalidated or missing value would otherwise turn into a
  // signature check that silently accepts the wrong secret.
  return stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
};

/**
 * Record the event, returning false when this delivery has already been handled.
 *
 * The insert is the primary concurrency control: two simultaneous deliveries of
 * the same event race here, and exactly one wins on the unique index.
 *
 * A duplicate insert alone is NOT sufficient to conclude "already handled",
 * because the winning attempt may itself have failed. `processEvent` marks a row
 * `failed` and rethrows precisely so Stripe retries, so the retry has to be able
 * to take the row back. Keying idempotency purely off insert-uniqueness meant a
 * retry hit the unique index, reported `duplicate`, and answered 200 — the retry
 * was silently swallowed and a paid order could be stranded in `pending_payment`
 * forever.
 *
 * So the duplicate path re-claims the row when — and only when — it is in a
 * terminal-pending-failure state:
 *
 *   received / processed / ignored -> someone owns it or already finished it.
 *                                    Report `duplicate` and do nothing.
 *   failed                          -> the previous attempt died and Stripe is
 *                                    retrying. Transition it back to `received`
 *                                    and process it again.
 *
 * The re-claim is a conditional `UPDATE ... WHERE status = 'failed'`, so the
 * check and the transition are one atomic statement. Two concurrent retries
 * cannot both win it, which keeps the at-least-once-to-exactly-once property
 * that the insert alone provided.
 */
const claimEvent = async (event: Stripe.Event): Promise<boolean> => {
  try {
    await db.insert(webhookEvents).values({
      id: newId(),
      stripeEventId: event.id,
      type: event.type,
      status: "received",
    });
    return true;
  } catch (error) {
    // Only a unique-constraint violation means "this event id is already in the
    // table". Swallowing every error would treat a database outage, a dropped
    // connection or a schema mismatch as a duplicate, answer 2xx, and stop Stripe
    // retrying — a lost payment with no way to recover. Anything else must
    // propagate so the route returns 5xx and the delivery is retried.
    if (!isDuplicateEntry(error)) throw error;
  }

  // Already recorded. Take it back only if the previous attempt failed.
  const [reclaimed] = await db
    .update(webhookEvents)
    .set({ status: "received", error: null, processedAt: null })
    .where(and(eq(webhookEvents.stripeEventId, event.id), eq(webhookEvents.status, "failed")));

  if ((reclaimed?.affectedRows ?? 0) === 0) return false;

  logger.info({ stripeEventId: event.id, type: event.type }, "re-claimed previously failed stripe event");
  return true;
};

const markEvent = async (eventId: string, status: "processed" | "failed" | "ignored", error?: string) => {
  await db
    .update(webhookEvents)
    .set({ status, error: error?.slice(0, 2000) ?? null, processedAt: new Date() })
    .where(eq(webhookEvents.stripeEventId, eventId));
};

/**
 * Mark a payment as succeeded and its order as paid.
 *
 * Guarded on the order's current status so a replayed or out-of-order event
 * cannot move an order backwards — for example a late `payment_failed` arriving
 * after a success would otherwise cancel a paid order.
 */
const settleOrder = async (intent: Stripe.PaymentIntent): Promise<void> => {
  const orderId = intent.metadata.orderId;
  if (!orderId) {
    throw new Error(`PaymentIntent ${intent.id} carried no orderId metadata.`);
  }

  const settled = await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.stripePaymentIntentId, intent.id))
      .limit(1);

    if (!payment) throw new Error(`No payment row for PaymentIntent ${intent.id}.`);

    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error(`No order row for orderId ${orderId}.`);

    // Amount reconciliation. `amount_received` is what Stripe actually captured,
    // which can differ from `amount` when the intent was authorised for less.
    if (intent.amount_received !== order.totalCents) {
      throw new Error(
        `Amount mismatch on ${intent.id}: received ${intent.amount_received}, order expects ${order.totalCents}.`,
      );
    }

    const card = typeof intent.payment_method === "string" ? null : intent.payment_method;

    await tx
      .update(payments)
      .set({
        status: "succeeded",
        // Only ever the last four digits and the brand. The PAN never reaches us.
        cardLast4: card?.card?.last4 ?? null,
        cardBrand: card?.card?.brand ?? null,
      })
      .where(eq(payments.id, payment.id));

    // `placedAt` is set here rather than at order creation: the order genuinely
    // exists only once money has moved.
    await tx
      .update(orders)
      .set({ status: "paid", placedAt: order.placedAt ?? new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending_payment")));

    return { orderNumber: order.orderNumber, totalCents: order.totalCents, currency: order.currency };
  });

  /**
   * Receipt. Sent only after the transaction has committed, so it can describe
   * an order that is genuinely paid, and fired without being awaited: a slow
   * SMTP server must not delay the 200 Stripe is waiting on, and a mail failure
   * must never make Stripe retry a payment that has already settled.
   * `intent.receipt_email` is the address the shopper checked out with.
   */
  const to = intent.receipt_email;
  if (to) {
    void sendOrderConfirmation(to, settled.orderNumber, settled.totalCents, settled.currency).catch((error) =>
      logger.error({ err: error, orderId }, "failed to send order confirmation email"),
    );
  }
};

/**
 * Record a declined payment attempt.
 *
 * The order goes to `failed` and — deliberately — keeps its stock reservation.
 * A decline is a fact about one card, not about the order: the shopper is
 * expected to try another card, and the reservation is exactly what holds their
 * units while they do. Releasing here would mean fumbling a card costs you the
 * last item to whoever refreshes the page next.
 *
 * The genuinely terminal case, a cancelled intent, is a separate handler that
 * does release the stock.
 *
 * The status write is guarded on the order still being `pending_payment`, so a
 * late decline cannot cancel an order that has already been paid.
 */
const failPayment = async (intent: Stripe.PaymentIntent): Promise<void> => {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, intent.id))
    .limit(1);
  if (!payment) return;

  const charge = typeof intent.latest_charge === "string" ? null : intent.latest_charge;
  // The decline detail lives on the charge outcome. `network_decline_code` is the
  // issuer's two-digit code and is the most useful thing to store for support;
  // `advice_code` is the finer-grained follow-up action and is the fallback.
  const declineCode = charge?.outcome?.network_decline_code ?? charge?.outcome?.advice_code ?? null;

  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        status: "requires_payment_method",
        failureCode: declineCode ?? intent.status,
        // Truncated to the column width; Stripe messages can be long and are not
        // attacker-controlled in a way that matters here.
        failureMessage: (intent.last_payment_error?.message ?? "Payment failed.").slice(0, 255),
      })
      .where(eq(payments.id, payment.id));

    // Only downgrade an order that is still awaiting payment, so a late failure
    // event cannot cancel an order that has already been paid.
    await tx
      .update(orders)
      .set({ status: "failed" })
      .where(and(eq(orders.id, payment.orderId), eq(orders.status, "pending_payment")));
  });
};

/**
 * A cancelled intent is terminal: Stripe will never capture it.
 *
 * So the order is closed and its reserved stock is handed back. That release is
 * idempotent on `orders.stock_released_at`, which is what makes it safe for this
 * event to be delivered twice, and safe for it to race the expiry sweep — only one
 * of them restocks.
 *
 * A missing payment row is not an error. It means the order was created but the
 * PaymentIntent never got recorded, which is the crash-between-commit-and-Stripe
 * case `resumeOrder` exists to repair; there is no reservation attached to a
 * payment row we cannot find, so there is nothing to undo.
 */
const cancelPaymentIntent = async (intent: Stripe.PaymentIntent): Promise<void> => {
  const [payment] = await db
    .select({ id: payments.id, orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, intent.id))
    .limit(1);
  if (!payment) return;

  await db
    .update(payments)
    .set({
      status: "canceled",
      failureCode: "canceled",
      failureMessage: "The payment was cancelled before it completed.",
    })
    .where(eq(payments.id, payment.id));

  await cancelAndReleaseStock(payment.orderId, "stripe payment_intent.canceled");
};

/**
 * Record a refund against a charge.
 *
 * Stripe refunds cumulatively: every `charge.refunded` event carries the running
 * `amount_refunded` for the whole charge, not a delta. So the events are
 * addressed by total, and `partially_refunded` is distinguished from `refunded`
 * by comparing that total against what was captured. Marking a 40%-refunded order
 * as `refunded` would tell the customer the money was all back when they still
 * owed the balance.
 */
export const markRefunded = async (charge: Stripe.Charge): Promise<void> => {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return;

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  if (!payment) return;

  // `amount_captured` is null on a charge that was never captured. Coalescing to 0
  // keeps `LEAST(0, n)` at 0 rather than producing NULL, which would write NULL
  // into a NOT NULL column and abort the transaction.
  const capturedCents = charge.amount_captured ?? 0;
  const refundedCents = charge.amount_refunded;
  const refundStatus = refundedCents >= capturedCents ? "refunded" : "partially_refunded";

  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      // Clamped so a cumulative-refund sequence can never record more than was
      // captured, which would make a later partial refund look negative.
      .set({
        status: refundStatus,
        refundedCents: sql`LEAST(${capturedCents}, ${refundedCents})`,
      })
      .where(eq(payments.id, payment.id));

    await tx
      .update(orders)
      .set({
        status: refundStatus,
        refundedCents: sql`LEAST(${orders.totalCents}, ${refundedCents})`,
      })
      .where(and(eq(orders.id, payment.orderId), inArray(orders.status, ["paid", "partially_refunded"])));
  });
};

/**
 * Process one verified event.
 *
 * Returns the outcome so the route can log it. Never throws for an unrecognised
 * event type: acknowledging is correct, since a 4xx would make Stripe retry a
 * payload that will never become processable.
 */
export const processEvent = async (event: Stripe.Event): Promise<WebhookOutcome> => {
  if (!(await claimEvent(event))) {
    logger.info({ stripeEventId: event.id, type: event.type }, "duplicate stripe event ignored");
    return "duplicate";
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await settleOrder(event.data.object);
        break;

      case "payment_intent.payment_failed":
        await failPayment(event.data.object);
        break;

      case "payment_intent.canceled":
        await cancelPaymentIntent(event.data.object);
        break;

      case "charge.refunded":
        await markRefunded(event.data.object);
        break;

      default:
        // Recorded and acknowledged: the event is retained for audit, and
        // returning success stops pointless retries.
        await markEvent(event.id, "ignored");
        logger.debug({ stripeEventId: event.id, type: event.type }, "unhandled stripe event type");
        return "ignored";
    }

    await markEvent(event.id, "processed");
    logger.info({ stripeEventId: event.id, type: event.type }, "stripe event processed");
    return "processed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markEvent(event.id, "failed", message);
    // Rethrown so the route answers 500: a genuinely failed reconciliation must
    // be retried by Stripe rather than silently accepted.
    logger.error({ err: error, stripeEventId: event.id, type: event.type }, "stripe event processing failed");
    throw error;
  }
};
/**
 * Settle an order by asking Stripe directly about its PaymentIntent.
 *
 * The order only becomes `paid` through the `payment_intent.succeeded` webhook,
 * which is correct in production but a dead end in local development: Stripe
 * cannot deliver a webhook to `localhost`, and this project's `STRIPE_WEBHOOK_SECRET`
 * is a placeholder rather than a real `whsec_…`, so `constructEvent` would reject
 * the delivery even if one arrived. The result is a shopper whose card was
 * genuinely charged watching "Confirming your payment…" forever.
 *
 * This closes that gap without weakening anything: it retrieves the intent from
 * Stripe and runs the *same* `settleOrder` the webhook runs, so both paths share
 * one reconciliation — amount check, guarded status write, receipt email — and
 * are safe to run in either order or twice. `settleOrder` is a no-op when the
 * order is already paid, and the guarded `UPDATE ... WHERE status = 'pending_payment'`
 * means a late webhook cannot move a settled order backwards.
 *
 * Returns the order's status after the attempt. `missing` means the number is
 * unknown or has no payment row yet.
 */
export const reconcileOrderPayment = async (
  orderNumber: string,
): Promise<"paid" | "pending" | "missing"> => {
  const [order] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return "missing";

  // Already settled (by a webhook, a prior reconcile, or a refund): nothing to do.
  if (order.status === "paid" || order.status === "partially_refunded" || order.status === "refunded") {
    return "paid";
  }
  if (order.status !== "pending_payment" && order.status !== "failed") {
    return "pending";
  }

  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
  if (!payment) return "missing";

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
  } catch (error) {
    // A transient Stripe failure is not a reason to fail the caller; the next
    // poll (or the webhook) will retry.
    logger.warn({ err: error, orderNumber }, "could not retrieve payment intent for reconciliation");
    return "pending";
  }

  if (intent.status !== "succeeded") return "pending";

  try {
    await settleOrder(intent);
    return "paid";
  } catch (error) {
    // `settleOrder` throws on an amount mismatch or a missing row — a genuine
    // fault that should be visible, not silently reported as success.
    logger.error({ err: error, orderNumber }, "payment reconciliation could not settle the order");
    return "pending";
  }
};
