import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../../middleware/auth.js";
import { contactLimiter } from "../../middleware/security.js";
import { asyncHandler, validateRequest, validatedBody } from "../../middleware/validate.js";
import { contactCreateSchema, newsletterSubscribeSchema } from "../schemas.js";
import * as contact from "./contact.service.js";
/**
 * Public contact and newsletter endpoints.
 *
 * Both are reachable without an account — a customer who cannot sign in still
 * needs to reach support — so both are behind `contactLimiter` and both take
 * their rate-limit key from the IP rather than a token subject.
 *
 * `optionalAuth` runs on the public surface, so a malformed or expired cookie
 * from a returning customer does not turn a contact submission into a 401. When
 * a session does resolve, the message is linked to that account.
 */
export const contactRouter = Router();
/**
 * Inline rather than shared with `emailSchema`: this is the one endpoint that must
 * work for a visitor who never made it through the app's form validation, so it
 * carries its own parser and its own generic wording.
 */
const unsubscribeSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict();
contactRouter.post("/", optionalAuth, contactLimiter, validateRequest({ body: contactCreateSchema }), asyncHandler(async (req, res) => {
    const body = validatedBody(req, contactCreateSchema);
    // `req.auth` is left undefined by optionalAuth when there is no valid session,
    // which is the correct value for a nullable column — not an error.
    const stored = await contact.createMessage(body, req.auth?.userId ?? null);
    res.status(201).json({ id: stored.id });
}));
contactRouter.post("/newsletter", optionalAuth, contactLimiter, validateRequest({ body: newsletterSubscribeSchema }), asyncHandler(async (req, res) => {
    const { email } = validatedBody(req, newsletterSubscribeSchema);
    const result = await contact.subscribe(email, req.auth?.userId ?? null);
    res.json(result);
}));
/**
 * Unsubscribe by email alone, with no auth.
 *
 * This looks like an IDOR and is not: the endpoint can only ever move a row to
 * `is_active = false`, reveals nothing about whether the address was on the
 * list beyond the row existing, and is reachable by anyone who was ever sent the
 * newsletter. Requiring a login here would be actively harmful — the person who
 * most needs to opt out is the one who lost access to the account that
 * subscribed them. No unsubscribe link is trustworthy if it can fail.
 */
contactRouter.post("/newsletter/unsubscribe", contactLimiter, validateRequest({ body: unsubscribeSchema }), asyncHandler(async (req, res) => {
    const { email } = validatedBody(req, unsubscribeSchema);
    await contact.unsubscribe(email);
    res.status(204).end();
}));
//# sourceMappingURL=contact.routes.js.map