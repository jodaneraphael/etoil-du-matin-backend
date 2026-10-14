import type { InferInsertModel } from "drizzle-orm";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { refreshTokens, sessions, users, type UserRole } from "../db/schema.js";
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

/**
 * Every value the client sent for `edm_rt`, in header order.
 *
 * `req.cookies` is not enough. `cookie-parser` collapses duplicate names to the
 * **first** one, and a browser that logged in before the shared `COOKIE_DOMAIN`
 * change holds a host-only `edm_rt` *and* the newer domain-scoped one. The
 * host-only copy is sent first, so the parser would hand the server a token that
 * was already rotated away from — surfacing as a spurious "already been used"
 * and logging the user out on every load.
 *
 * Reading the raw header recovers all of them so the caller can act on whichever
 * is actually live. A stale duplicate therefore stops being fatal without
 * weakening reuse detection: a request carrying only revoked tokens still has no
 * active candidate and is still rejected.
 */
export const refreshTokenCandidates = (req: {
  headers: { cookie?: string };
  cookies?: Record<string, unknown>;
}): string[] => {
  const values: string[] = [];
  const raw = req.headers?.cookie;
  if (raw) {
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
      let value = part.slice(eq + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // A malformed escape is left as-is; the hash lookup simply will not match.
      }
      if (value && !values.includes(value)) values.push(value);
    }
  }
  const fallback = req.cookies?.[REFRESH_COOKIE];
  if (typeof fallback === "string" && fallback && !values.includes(fallback)) values.push(fallback);
  return values;
};

const MAX_REFRESH_MS = env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  /** The rotation family, which doubles as the session identifier. */
  sessionId: string;
  expiresAt: Date;
}

export interface ClientFingerprint {
  ip?: string;
  userAgent?: string;
}

/** Shared `Domain`, or nothing when cookies should stay host-only. */
const SHARED_DOMAIN = env.cookieDomain ? { domain: env.cookieDomain } : {};

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
  ...SHARED_DOMAIN,
} as const;

const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  sameSite: "strict",
  secure: env.isProduction,
  path: "/",
  ...SHARED_DOMAIN,
} as const;

/**
 * Delete the host-only variant of both auth cookies.
 *
 * Needed only while transitioning to a shared `COOKIE_DOMAIN`: a browser that
 * logged in before the change still holds host-only `edm_rt`/`edm_csrf` cookies,
 * and would then send *two* cookies of the same name. `cookie-parser` keeps the
 * first, which may be the stale host-only one, so the server could read a
 * refresh token it has already rotated away from — surfacing as a spurious
 * reuse-detection logout. Clearing the host-only copies on the next auth
 * response removes the ambiguity.
 */
const clearHostOnlyVariants = (res: import("express").Response): void => {
  if (!env.cookieDomain) return;
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_COOKIE_OPTIONS, domain: undefined });
  // The refresh cookie's path is `/api/auth` today, but a copy left under `/`
  // by an older build would not be matched by the clear above and would keep
  // shadowing the shared-domain cookie. Clear both spellings.
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_COOKIE_OPTIONS, domain: undefined, path: "/" });
  res.clearCookie(CSRF_COOKIE, { ...CSRF_COOKIE_OPTIONS, domain: undefined });
};

export const setAuthCookies = (res: import("express").Response, tokens: IssuedTokens): void => {
  clearHostOnlyVariants(res);
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...REFRESH_COOKIE_OPTIONS, maxAge: MAX_REFRESH_MS });
  res.cookie(CSRF_COOKIE, tokens.csrfToken, { ...CSRF_COOKIE_OPTIONS, maxAge: MAX_REFRESH_MS });
};

export const clearAuthCookies = (res: import("express").Response): void => {
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.clearCookie(CSRF_COOKIE, CSRF_COOKIE_OPTIONS);
  clearHostOnlyVariants(res);
};

interface RefreshRecordBundle {
  record: InferInsertModel<typeof refreshTokens>;
  refreshToken: string;
  csrfToken: string;
  expiresAt: Date;
}

const buildRefreshRecord = (
  userId: string,
  familyId: string,
  client: ClientFingerprint,
): RefreshRecordBundle => {
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
export const issueTokens = async (
  userId: string,
  role: UserRole,
  client: ClientFingerprint,
): Promise<IssuedTokens> => {
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

export interface RotationResult {
  tokens: IssuedTokens;
  user: { id: string; email: string; name: string; role: UserRole };
}

/**
 * Revoke every live token in a family, plus the session that owns it.
 */
export const revokeFamily = async (tx: Tx, familyId: string, reason: string): Promise<void> => {
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

export const revokeFamilyById = async (familyId: string, reason: string): Promise<void> => {
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
export const rotateRefreshToken = async (
  presentedToken: string,
  client: ClientFingerprint,
): Promise<RotationResult> => rotateRefreshTokens([presentedToken], client);

/**
 * Rotate whichever of the presented tokens is currently live.
 *
 * Almost always there is exactly one. The list form exists for the duplicate
 * cookie case documented on `refreshTokenCandidates`: a stale host-only token
 * rides alongside the live domain-scoped one, and choosing by header order would
 * pick the dead one. Selecting the active candidate makes that benign.
 *
 * Reuse detection is unchanged outside the grace window. If none of the
 * candidates is active and none was rotated moments ago (see
 * `env.refreshReuseGraceSeconds`), the family is revoked exactly as before.
 */
export const rotateRefreshTokens = async (
  presentedTokens: string[],
  client: ClientFingerprint,
): Promise<RotationResult> => {
  const hashes = [...new Set(presentedTokens.filter((token) => token.length > 0).map(sha256))];
  if (hashes.length === 0) throw unauthorized("Refresh token is not recognised.");

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
    const rows = await tx
      .select()
      .from(refreshTokens)
      .where(inArray(refreshTokens.tokenHash, hashes))
      .for("update");

    const now = Date.now();
    let row = rows.find((candidate) => candidate.revokedAt === null && candidate.expiresAt.getTime() > now);

    /**
     * Benign-duplicate recovery. See `env.refreshReuseGraceSeconds`.
     *
     * No live candidate was presented, but if one of them was retired by a
     * rotation moments ago and its family still has a live successor, this is a
     * client that raced itself (two tabs, a retried request) — not a thief.
     * Rotate the live successor so the caller still ends up authenticated; the
     * family is left intact. A replay outside the window is handled by the
     * reuse path below, unchanged.
     */
    if (!row && env.refreshReuseGraceSeconds > 0) {
      const graceMs = env.refreshReuseGraceSeconds * 1000;
      const recentlyRotated = rows.find(
        (candidate) =>
          candidate.revokedAt !== null &&
          candidate.revokedReason === "rotated" &&
          now - candidate.revokedAt.getTime() <= graceMs,
      );
      if (recentlyRotated) {
        const [live] = await tx
          .select()
          .from(refreshTokens)
          .where(
            and(
              eq(refreshTokens.familyId, recentlyRotated.familyId),
              isNull(refreshTokens.revokedAt),
              gt(refreshTokens.expiresAt, new Date(now)),
            ),
          )
          .orderBy(desc(refreshTokens.createdAt))
          .limit(1)
          .for("update");
        if (live) {
          row = live;
          logger.info(
            { familyId: live.familyId, userId: live.userId },
            "refresh token replay within grace window; rotating the live successor",
          );
        }
      }
    }

    if (!row) {
      // No live token among the candidates. Prefer the theft signal: a revoked
      // token means this is a replay, and the whole family must die. Only when
      // nothing is revoked is this an ordinary expiry.
      const revoked = rows.find((candidate) => candidate.revokedAt !== null);
      if (revoked) {
        await revokeFamily(tx, revoked.familyId, "reuse_detected");
        logger.warn({ familyId: revoked.familyId, userId: revoked.userId }, "refresh token reuse detected; family revoked");
        return { ok: false as const, reason: "reuse" as const };
      }

      const expired = rows.find((candidate) => candidate.expiresAt.getTime() <= now);
      if (expired) {
        await revokeFamily(tx, expired.familyId, "expired");
        return { ok: false as const, reason: "expired" as const };
      }

      // Never issued, or already purged. Reject without revealing which.
      return { ok: false as const, reason: "unrecognised" as const };
    }

    const [user] = await tx
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    if (!user) {
      await revokeFamily(tx, row.familyId, "user_missing");
      return { ok: false as const, reason: "user_missing" as const };
    }

    const { record, refreshToken, csrfToken, expiresAt } = buildRefreshRecord(user.id, row.familyId, client);

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: "rotated" })
      .where(eq(refreshTokens.id, row.id));

    await tx.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.familyId));

    await tx.insert(refreshTokens).values(record);

    return {
      ok: true as const,
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

  if (outcome.ok) return outcome.result;

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
export const revokeAllForUser = async (userId: string, reason: string): Promise<void> => {
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
export const revokeByToken = async (presentedToken: string): Promise<void> => {
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
export const pruneExpiredTokens = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [tokenResult] = await db
    .delete(refreshTokens)
    .where(and(lt(refreshTokens.expiresAt, cutoff), lt(refreshTokens.createdAt, cutoff)));

  await db.delete(sessions).where(and(lt(sessions.createdAt, cutoff), isNotNull(sessions.revokedAt)));

  return tokenResult.affectedRows ?? 0;
};
