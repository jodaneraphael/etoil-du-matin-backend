import { Router } from "express";
import { requireCsrf } from "../../middleware/csrf.js";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter, refreshLimiter, registerLimiter, writeLimiter } from "../../middleware/security.js";
import { asyncHandler, params, requireAuthContext, validateRequest } from "../../middleware/validate.js";
import { AppError, invalidCredentials } from "../../lib/errors.js";
import { REFRESH_COOKIE } from "../../lib/tokens.js";
import * as auth from "./auth.service.js";
import {
  addressParamsSchema,
  addressSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateAddressSchema,
  updateProfileSchema,
} from "../schemas.js";

export const authRouter = Router();

/**
 * Fingerprint the client for token binding. Only the hash of these values is
 * stored, so the session table holds no raw IP or user-agent string while still
 * allowing "all sessions from this device" to be reasoned about.
 */
const fingerprintOf = (req: import("express").Request) => ({
  ip: req.ip,
  userAgent: req.get("user-agent")?.slice(0, 256),
});

/**
 * Pre-flight duplicate check for registration.
 *
 * Purely for message quality — the insert's unique index is what actually
 * guarantees correctness. Reporting the conflict here, rather than waiting for
 * the insert, means a genuine duplicate gets a clear 409 instead of surfacing
 * through the generic duplicate-entry path.
 */
authRouter.post(
  "/register",
  registerLimiter,
  validateRequest({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const existing = await auth.getUserByEmail(req.body.email);
    if (existing) {
      throw new AppError(409, "email_taken", "An account with that email address already exists.");
    }

    const result = await auth.register(req.body, fingerprintOf(req));
    auth.setAuthCookies(res, result.tokens);
    res.status(201).json({ user: result.user, accessToken: result.tokens.accessToken });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validateRequest({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await auth.login(req.body, fingerprintOf(req));
    auth.setAuthCookies(res, result.tokens);
    res.json({ user: result.user, accessToken: result.tokens.accessToken });
  }),
);

/**
 * Token rotation.
 *
 * `requireCsrf` guards this endpoint because it is the only one that acts on the
 * httpOnly refresh cookie rather than a bearer token. Rotating also means a
 * stolen token is single-use and its reuse is detected on the next attempt.
 */
authRouter.post(
  "/refresh",
  requireCsrf,
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== "string" || token.length === 0) {
      throw invalidCredentials();
    }

    const result = await auth.rotateRefreshToken(token, fingerprintOf(req));
    auth.setAuthCookies(res, result.tokens);
    res.json({ user: result.user, accessToken: result.tokens.accessToken });
  }),
);

authRouter.post(
  "/logout",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    // Idempotent: signing out twice, or with an expired cookie, is a success.
    if (typeof token === "string" && token.length > 0) {
      await auth.revokeByToken(token);
    }
    auth.clearAuthCookies(res);
    res.status(204).end();
  }),
);

/** Current account. Cheap enough for the client to call on every page load. */
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json({ user: await auth.getUserById(userId) });
  }),
);

authRouter.patch(
  "/me",
  requireAuth,
  writeLimiter,
  validateRequest({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json({ user: await auth.updateProfile(userId, req.body) });
  }),
);

/**
 * Password change. Every other session is revoked, so the response deliberately
 * does not hand back a new token pair — the client is expected to sign in
 * again with the new credential.
 */
authRouter.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validateRequest({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    await auth.changePassword(userId, req.body);
    auth.clearAuthCookies(res);
    res.status(204).end();
  }),
);

/**
 * Password reset, step 1. Always answers 200 with the same shape; `devCode` is
 * only present outside production, where the code is also written to the server
 * log for operator-assisted resets.
 */
authRouter.post(
  "/forgot-password",
  authLimiter,
  validateRequest({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    res.json(await auth.requestPasswordReset(req.body));
  }),
);

/** Password reset, step 2: code + new password. */
authRouter.post(
  "/reset-password",
  authLimiter,
  validateRequest({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    await auth.resetPassword(req.body);
    res.json({ ok: true });
  }),
);

// ── Addresses ──────────────────────────────────────────────────────────────

authRouter.get(
  "/addresses",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.json({ addresses: await auth.listAddresses(userId) });
  }),
);

authRouter.post(
  "/addresses",
  requireAuth,
  writeLimiter,
  validateRequest({ body: addressSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    res.status(201).json({ address: await auth.createAddress(userId, req.body) });
  }),
);

authRouter.patch(
  "/addresses/:id",
  requireAuth,
  writeLimiter,
  validateRequest({ params: addressParamsSchema, body: updateAddressSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { id } = params(req, addressParamsSchema);
    res.json({ address: await auth.updateAddress(userId, id, req.body) });
  }),
);

authRouter.delete(
  "/addresses/:id",
  requireAuth,
  writeLimiter,
  validateRequest({ params: addressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { id } = params(req, addressParamsSchema);
    await auth.deleteAddress(userId, id);
    res.status(204).end();
  }),
);

authRouter.post(
  "/addresses/:id/default",
  requireAuth,
  writeLimiter,
  validateRequest({ params: addressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = requireAuthContext(req);
    const { id } = params(req, addressParamsSchema);
    await auth.setDefaultAddress(userId, id);
    res.status(204).end();
  }),
);
