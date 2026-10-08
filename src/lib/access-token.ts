import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { env } from "../env.js";
import { unauthorized } from "./errors.js";
import type { UserRole } from "../db/schema.js";

/**
 * Access tokens are short-lived (15 min by default) signed JWTs. They are
 * deliberately *not* revocable by design — revocation lives in the `sessions`
 * table and is checked on the refresh path. Keeping the access token stateless
 * avoids a database read on every request; the short TTL bounds the damage
 * window if one is ever leaked.
 *
 * The signing key is supplied as a Uint8Array because `jose` requires key
 * material to be bytes, and HS256 requires at least 256 bits of key.
 */
const secretKey = new TextEncoder().encode(env.jwtSecret);

const ISSUER = "etoil-du-matin-api";
const AUDIENCE = "etoil-du-matin-web";

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: UserRole;
}

export const signAccessToken = async (claims: AccessTokenClaims): Promise<string> =>
  new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    // Small leeway absorbs clock drift between the API and the client.
    .setExpirationTime(`${env.accessTokenTtlSeconds}s`)
    .setJti(claims.sid)
    .sign(secretKey);

/**
 * Verify signature, algorithm, issuer and audience.
 *
 * `algorithms` is pinned explicitly. Without it, JWT best practice is to
 * reject: it removes the "alg: none" and algorithm-confusion classes of attack,
 * where an attacker presents a token signed with a public key or with no
 * signature at all.
 */
export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 5,
    });

    if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
      throw unauthorized("Malformed access token.");
    }
    const role = payload.role;
    if (role !== "customer" && role !== "admin") {
      throw unauthorized("Malformed access token.");
    }

    return { sub: payload.sub, sid: payload.jti, role };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      // One opaque message for every failure mode — expired, bad signature,
      // wrong audience and malformed all look identical to the caller.
      throw unauthorized("Access token is invalid or expired.");
    }
    throw error;
  }
};

export const accessTokenTtlSeconds = env.accessTokenTtlSeconds;
