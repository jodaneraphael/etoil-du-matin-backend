import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { verifyAccessToken } from "../lib/access-token.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { fingerprint } from "../lib/ids.js";
const BEARER = /^Bearer\s+(\S+)$/i;
const extractToken = (req) => {
    const header = req.get("authorization");
    if (!header)
        return undefined;
    const match = BEARER.exec(header.trim());
    return match?.[1];
};
/**
 * Require a valid access token.
 *
 * The session row is checked on every request rather than trusting the JWT
 * alone. A stateless access token cannot express revocation, so without this
 * lookup a token issued before a password change or a forced logout would keep
 * working for its full 15-minute lifetime. The read is a single indexed
 * primary-key lookup on a small table.
 */
export const requireAuth = async (req, _res, next) => {
    try {
        const token = extractToken(req);
        if (!token)
            throw unauthorized("Authentication required.");
        const claims = await verifyAccessToken(token);
        const [row] = await db
            .select({
            revokedAt: sessions.revokedAt,
            userId: sessions.userId,
            userAgentHash: sessions.userAgentHash,
        })
            .from(sessions)
            .where(eq(sessions.id, claims.sid))
            .limit(1);
        if (!row || row.revokedAt !== null)
            throw unauthorized("Session is no longer valid.");
        if (row.userId !== claims.sub)
            throw unauthorized("Token subject mismatch.");
        // Token binding: a stolen bearer token replayed from a different client is
        // rejected. This is a strong signal rather than an absolute guarantee,
        // since user-agent strings are trivially spoofable.
        if (row.userAgentHash) {
            const presented = fingerprint(req.get("user-agent") ?? "");
            if (presented !== row.userAgentHash) {
                throw unauthorized("Session is bound to a different client.");
            }
        }
        req.auth = { userId: claims.sub, sessionId: claims.sid, role: claims.role };
        next();
    }
    catch (error) {
        next(error);
    }
};
/**
 * Attach `req.auth` when a valid token is present, but never reject. Used on
 * endpoints whose behaviour differs for signed-in users (a cart that merges on
 * login, an order history that includes guest purchases) while remaining usable
 * anonymously.
 */
export const optionalAuth = async (req, _res, next) => {
    const token = extractToken(req);
    if (!token)
        return next();
    try {
        const claims = await verifyAccessToken(token);
        const [row] = await db
            .select({ revokedAt: sessions.revokedAt, userId: sessions.userId })
            .from(sessions)
            .where(eq(sessions.id, claims.sid))
            .limit(1);
        if (row && row.revokedAt === null && row.userId === claims.sub) {
            req.auth = { userId: claims.sub, sessionId: claims.sid, role: claims.role };
        }
    }
    catch {
        // An invalid optional token is simply ignored; the request continues anonymously.
    }
    next();
};
/**
 * Restrict a route to admins. Must run after `requireAuth`.
 *
 * The role is re-read from the database rather than taken from the token, so a
 * demotion takes effect immediately instead of after the token expires. The
 * role claim in the JWT is only a hint for routing decisions.
 */
export const requireAdmin = async (req, _res, next) => {
    try {
        if (!req.auth)
            throw unauthorized("Authentication required.");
        const [row] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, req.auth.userId))
            .limit(1);
        if (!row)
            throw unauthorized("Account no longer exists.");
        if (row.role !== "admin")
            throw forbidden("Administrator access required.");
        req.auth.role = row.role;
        next();
    }
    catch (error) {
        next(error);
    }
};
/** Narrowing helper so handlers get a typed user id without a non-null assertion. */
export const currentUserId = (req) => {
    if (!req.auth)
        throw unauthorized("Authentication required.");
    return req.auth.userId;
};
//# sourceMappingURL=auth.js.map