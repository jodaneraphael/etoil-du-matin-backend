import { env } from "../env.js";
import { hmacSha256, safeEqual } from "../lib/ids.js";
import { forbidden } from "../lib/errors.js";
import { CSRF_COOKIE, REFRESH_COOKIE } from "../lib/tokens.js";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER = "x-csrf-token";
/**
 * Derive the CSRF value that accompanies a given refresh token.
 *
 * Binding it to the refresh token by HMAC means the value cannot be guessed or
 * replayed independently of the credential it protects.
 */
export const mintCsrfToken = (refreshToken) => hmacSha256(env.csrfSecret, `${CSRF_COOKIE}:${refreshToken}`);
/**
 * Double-submit CSRF verification, applied to the cookie-authenticated session
 * endpoints (`/api/auth/refresh`, `/api/auth/logout`).
 *
 * Two independent checks must pass:
 *
 *  1. The `X-CSRF-Token` header matches the readable `edm_csrf` cookie. This
 *     is the classic double-submit pattern: a cross-site attacker can cause the
 *     cookie to be sent but cannot read it, so cannot populate the header.
 *
 *  2. The header equals the HMAC of the *refresh token itself* under
 *     CSRF_SECRET. A leaked CSRF cookie on its own is therefore not enough —
 *     the attacker would need the httpOnly refresh cookie too, which
 *     JavaScript cannot read even under XSS.
 *
 * Comparison is constant-time in both places.
 *
 * This is layered on top of two other protections rather than replacing them:
 * the refresh cookie is `SameSite=Strict` so browsers withhold it cross-site
 * outright, and `/api/auth/refresh` is the only endpoint that reads it. This
 * check is what keeps that safe if the SameSite attribute is ever weakened
 * while debugging.
 *
 * Endpoints authenticated purely by a bearer token are not listed here: a
 * cross-site attacker cannot set an `Authorization` header, so those routes
 * have no CSRF surface to begin with.
 */
export const requireCsrf = (req, _res, next) => {
    if (SAFE_METHODS.has(req.method))
        return next();
    const refreshCookie = req.cookies?.[REFRESH_COOKIE];
    const csrfCookie = req.cookies?.[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (!refreshCookie || !csrfCookie || !header) {
        return next(forbidden("CSRF token is required for this request."));
    }
    const expected = mintCsrfToken(String(refreshCookie));
    if (!safeEqual(String(csrfCookie), header) || !safeEqual(expected, header)) {
        return next(forbidden("CSRF token mismatch."));
    }
    next();
};
//# sourceMappingURL=csrf.js.map