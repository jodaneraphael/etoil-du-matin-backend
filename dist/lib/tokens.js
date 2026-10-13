import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { refreshTokens, sessions, users } from "../db/schema.js";
import { env } from "../env.js";
import { signAccessToken } from "./access-token.js";
import { unauthorized } from "./errors.js";
import { fingerprint, newId, randomToken, sha256 } from "./ids.js";
import { logger } from "./logger.js";
import { mintCsrfToken } from "../middleware/csrf.js";
export const REFRESH_COOKIE = "edm_rt";
/**
 * Non-secret companion to the refresh cookie. Readable by JavaScript on
 * purpose so the frontend can echo it in a header; it exists purely so the
 * refresh endpoint can perform a double-submit check.
 */
export const CSRF_COOKIE = "edm_csrf";
const MAX_REFRESH_MS = env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
/**
 * Cookie hardening:
 *
 * httpOnly    — keeps the token out of `document.cookie`, so an XSS bug cannot
 *               read it.
 * sameSite    — "strict" means the browser withholds the cookie on any
 *               cross-site request, which neutralises CSRF on /api/auth
 *               without depending on an anti-CSRF token being present.
 * secure      — HTTPS only in production.
 * path        — restricts transmission to /api/auth, so the credential is not
 *               attached to every catalogue request or leaked in access logs.
 * domain      — set to `COOKIE_DOMAIN` so the cookie is shared across the SPA
 *               and API subdomains; blank keeps it host-only (localhost,
 *               same-origin). Without this the SPA cannot read `edm_csrf` and
 *               the double-submit check fails with 403 on every refresh.
 */
const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: "strict",
    secure: env.isProduction,
    path: "/api/auth",
    domain: env.cookieDomain,
};
export const setAuthCookies = (res, tokens) => {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...REFRESH_COOKIE_OPTIONS, maxAge: MAX_REFRESH_MS });
    res.cookie(CSRF_COOKIE, tokens.csrfToken, {
        httpOnly: false,
        sameSite: "strict",
        secure: env.isProduction,
        path: "/",
        domain: env.cookieDomain,
        maxAge: MAX_REFRESH_MS,
    });
};
export const clearAuthCookies = (res) => {
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
    res.clearCookie(CSRF_COOKIE, { ...REFRESH_COOKIE_OPTIONS, httpOnly: false, path: "/" });
};
const buildRefreshRecord = (userId, familyId, client) => {
    const refreshToken = randomToken(32);
    // Derived from the refresh token under CSRF_SECRET, so the CSRF value is
    // useless without the httpOnly credential it is bound to.
    const csrfToken = mintCsrfToken(refreshToken);
    const expiresAt = new Date(Date.now() + MAX_REFRESH_MS);
    return {
        refreshToken,
        csrfToken,
        expiresAt,
        record: {
            id: newId(),
            userId,
            tokenHash: sha256(refreshToken),
            familyId,
            expiresAt,
            ipHash: client.ip ? fingerprint(client.ip) : null,
            userAgentHash: client.userAgent ? fingerprint(client.userAgent) : null,
        },
    };
};
/**
 * Start a new session: a session row, the first refresh token in a fresh
 * rotation family, and a matching access token.
 *
 * The family id is reused as the session id (`sessions.id`) so there is exactly
 * one identifier per login, which keeps revocation a single lookup.
 */
export const issueTokens = async (userId, role, client) => {
    const familyId = newId();
    const { record, refreshToken, csrfToken, expiresAt } = buildRefreshRecord(userId, familyId, client);
    await db.transaction(async (tx) => {
        await tx.insert(sessions).values({
            id: familyId,
            userId,
            refreshFamilyId: familyId,
            ipHash: record.ipHash,
            userAgentHash: record.userAgentHash,
        });
        await tx.insert(refreshTokens).values(record);
    });
    return {
        accessToken: await signAccessToken({ sub: userId, sid: familyId, role }),
        refreshToken,
        csrfToken,
        sessionId: familyId,
        expiresAt,
    };
};
/**
 * Revoke every live token in a family, plus the session that owns it.
 */
export const revokeFamily = async (tx, familyId, reason) => {
    const now = new Date();
    await tx
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: reason })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.refreshFamilyId, familyId), isNull(sessions.revokedAt)));
};
export const revokeFamilyById = async (familyId, reason) => {
    await db.transaction((tx) => revokeFamily(tx, familyId, reason));
};
/**
 * Rotate a refresh token.
 *
 * The security property is reuse detection. Every refresh revokes the presented
 * token and issues a replacement in the same family. If an already-revoked
 * token is presented again, the cause is either a client retry or a stolen
 * token — and those are indistinguishable to the server. So the response is
 * identical for both: revoke the entire family. The attacker's copy dies and
 * the legitimate user is forced to re-authenticate, which is the intended
 * outcome for a suspected compromise.
 *
 * `FOR UPDATE` serialises concurrent refreshes. Without it two parallel
 * requests could both read a valid token and both mint successors, which would
 * defeat rotation entirely and re-open the replay window.
 */
export const rotateRefreshToken = async (presentedToken, client) => {
    const presentedHash = sha256(presentedToken);
    /**
     * The transaction returns a failure *value* instead of throwing.
     *
     * This is deliberate and load-bearing. Throwing inside the callback rolls the
     * transaction back — including any revocation the callback just performed. So
     * `revokeFamily(..., "reuse_detected")` immediately followed by a throw would
     * report a theft to the log while leaving the stolen token's descendants fully
     * valid, which defeats the entire purpose of rotation. Returning the failure
     * commits the revocation; the throw happens afterwards, outside the
     * transaction, once the family is durably dead.
     */
    const outcome = await db.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(refreshTokens)
            .where(eq(refreshTokens.tokenHash, presentedHash))
            .limit(1)
            .for("update");
        if (!row) {
            // Never issued, or already purged. Reject without revealing which.
            return { ok: false, reason: "unrecognised" };
        }
        if (row.revokedAt !== null) {
            await revokeFamily(tx, row.familyId, "reuse_detected");
            logger.warn({ familyId: row.familyId, userId: row.userId }, "refresh token reuse detected; family revoked");
            return { ok: false, reason: "reuse" };
        }
        if (row.expiresAt.getTime() <= Date.now()) {
            await revokeFamily(tx, row.familyId, "expired");
            return { ok: false, reason: "expired" };
        }
        const [user] = await tx
            .select({ id: users.id, email: users.email, name: users.name, role: users.role })
            .from(users)
            .where(eq(users.id, row.userId))
            .limit(1);
        if (!user) {
            await revokeFamily(tx, row.familyId, "user_missing");
            return { ok: false, reason: "user_missing" };
        }
        const { record, refreshToken, csrfToken, expiresAt } = buildRefreshRecord(user.id, row.familyId, client);
        await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date(), revokedReason: "rotated" })
            .where(eq(refreshTokens.id, row.id));
        await tx.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.familyId));
        await tx.insert(refreshTokens).values(record);
        return {
            ok: true,
            result: {
                user,
                tokens: {
                    accessToken: await signAccessToken({ sub: user.id, sid: row.familyId, role: user.role }),
                    refreshToken,
                    csrfToken,
                    sessionId: row.familyId,
                    expiresAt,
                },
            },
        };
    });
    if (outcome.ok)
        return outcome.result;
    // Raised only after the transaction has committed any revocation.
    switch (outcome.reason) {
        case "reuse":
            throw unauthorized("Refresh token has already been used. Please sign in again.");
        case "expired":
            throw unauthorized("Refresh token has expired. Please sign in again.");
        case "user_missing":
            throw unauthorized("Account is no longer available.");
        default:
            throw unauthorized("Refresh token is not recognised.");
    }
};
/** Invalidate every session for a user. Used after a password change. */
export const revokeAllForUser = async (userId, reason) => {
    await db.transaction(async (tx) => {
        const now = new Date();
        await tx
            .update(refreshTokens)
            .set({ revokedAt: now, revokedReason: reason })
            .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
        await tx
            .update(sessions)
            .set({ revokedAt: now })
            .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });
};
/**
 * Idempotent logout. Revokes when the token is recognised and returns cleanly
 * when it is not, so signing out twice (or with an expired cookie) is not an
 * error.
 */
export const revokeByToken = async (presentedToken) => {
    const [row] = await db
        .select({ familyId: refreshTokens.familyId, revokedAt: refreshTokens.revokedAt })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256(presentedToken)))
        .limit(1);
    if (row && row.revokedAt === null) {
        await revokeFamilyById(row.familyId, "logout");
    }
};
/**
 * Housekeeping. Rows can no longer grant access once both their expiry has
 * passed and the retention window has elapsed — the extra window keeps
 * recently-expired hashes around briefly for incident review. Active sessions
 * are never touched.
 *
 * MySQL has no `DELETE ... RETURNING`, so the affected-row count comes from the
 * driver result rather than from a returned row set.
 */
export const pruneExpiredTokens = async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [tokenResult] = await db
        .delete(refreshTokens)
        .where(and(lt(refreshTokens.expiresAt, cutoff), lt(refreshTokens.createdAt, cutoff)));
    await db.delete(sessions).where(and(lt(sessions.createdAt, cutoff), isNotNull(sessions.revokedAt)));
    return tokenResult.affectedRows ?? 0;
};
//# sourceMappingURL=tokens.js.map