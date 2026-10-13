import { Router } from "express";
import { optionalAuth } from "../../middleware/auth.js";
import { checkoutLimiter } from "../../middleware/security.js";
import { asyncHandler, requireAuthContext, validateRequest } from "../../middleware/validate.js";
import { logger } from "../../lib/logger.js";
import { createAddress } from "../auth/auth.service.js";
import { checkoutSchema, quoteSchema } from "../schemas.js";
import * as checkout from "./checkout.service.js";
/**
 * Checkout endpoints.
 *
 * Both are reachable anonymously: guest checkout is a supported flow, so a token
 * is optional rather than required. `requireAuthContext` is only used on the
 * branches that genuinely need a user id.
 */
export const checkoutRouter = Router();
/**
 * Price a basket.
 *
 * Read-only and unauthenticated. Lets the cart page and the checkout summary show
 * a figure produced by the same rules that will charge the card, rather than one
 * computed in the browser.
 */
checkoutRouter.post("/quote", checkoutLimiter, validateRequest({ body: quoteSchema }), asyncHandler(async (req, res) => {
    const { lines, totals } = await checkout.quote(req.body.items);
    res.json({ lines, totals });
}));
/**
 * Create an order and start a payment.
 *
 * Behind `checkoutLimiter` because this is the most expensive operation in the
 * system: it writes several tables, calls Stripe, and moves stock. The
 * `idempotencyKey` in the body is the real protection against a double charge;
 * the rate limit only bounds abuse.
 */
checkoutRouter.post("/", optionalAuth, checkoutLimiter, validateRequest({ body: checkoutSchema }), asyncHandler(async (req, res) => {
    const { userId } = req.auth ? requireAuthContext(req) : { userId: null };
    const result = await checkout.createOrder({
        email: req.body.email,
        shipping: req.body.shipping,
        items: req.body.items,
        idempotencyKey: req.body.idempotencyKey,
    }, userId);
    // Saving the address is a convenience layered on top of an order that has
    // already been placed, so a failure here must not fail the checkout — the
    // shopper has already bought the thing.
    if (userId && req.body.saveAddress) {
        try {
            await createAddress(userId, { ...req.body.shipping, label: "From checkout" });
        }
        catch (error) {
            logger.warn({ err: error, userId }, "could not save checkout address to the address book");
        }
    }
    res.status(result.replayed ? 200 : 201).json({
        orderNumber: result.orderNumber,
        clientSecret: result.clientSecret,
        publishableKey: result.publishableKey,
        totalCents: result.order.totalCents,
        currency: result.order.currency,
        ...(result.guestClaimToken ? { guestClaimToken: result.guestClaimToken } : {}),
    });
}));
//# sourceMappingURL=checkout.routes.js.map