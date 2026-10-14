import type { NextFunction, Request, Response } from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import rateLimit, { type Options } from "express-rate-limit";
import { env } from "../env.js";
import { forbidden, tooManyRequests } from "../lib/errors.js";

/**
 * Baseline response headers.
 *
 * The CSP is intentionally strict. This is a JSON API, so it never needs to
 * load scripts, styles or images itself; `default-src 'none'` plus explicit
 * allowances keeps a successful injection far from having anything to execute.
 * `frame-ancestors 'none'` blocks clickjacking, and the HSTS pre-load directive
 * is only emitted in production so it cannot pin a developer to localhost.
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      connectSrc: ["'none'"],
      upgradeInsecureRequests: env.isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-site" },
  referrerPolicy: { policy: "no-referrer" },
  // Do not advertise the framework and version.
  xPoweredBy: false,
  hsts: env.isProduction ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
});

/**
 * CORS with an explicit origin allowlist.
 *
 * `credentials: true` is required for the refresh cookie, and the browser
 * refuses to pair credentials with a wildcard origin — which is exactly why the
 * allowlist has to be an enumeration of real origins rather than "*".
 *
 * The origin callback resolves `undefined` for a disallowed origin, which makes
 * the cors middleware omit the CORS headers. The browser then blocks the
 * response, and the request still reaches the server (which is fine, because
 * the real defence for state-changing routes is the CSRF check, not CORS).
 */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true); // same-origin, curl, native clients
    if (env.corsOriginList.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key", "X-Requested-With"],
  exposedHeaders: ["RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

export const corsPolicy = cors(corsOptions);

/**
 * Reject a state-changing request whose Origin is not allowlisted, even if the
 * CORS headers were never consulted.
 *
 * Belt-and-braces against CSRF: a hidden cross-origin form POST can be
 * triggered by a third-party site, and while the browser will withhold our
 * SameSite=Strict cookie, verifying Origin explicitly means a misconfigured
 * cookie attribute cannot silently become an authentication bypass.
 *
 * `Sec-Fetch-Site` is preferred where available because it cannot be spoofed by
 * page JavaScript, unlike Origin in non-browser clients.
 */
export const originGuard = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return next();

  const origin = req.get("origin");
  if (!origin) {
    // No Origin header: a non-browser client (server-side, mobile, CLI).
    // Allowed through; the endpoints it can reach still require a bearer token.
    return next();
  }

  if (!env.corsOriginList.includes(origin)) {
    // 403, not 429: this is a rejected request, not an exhausted budget. A 429
    // invites the client to retry, and retrying an unpermitted origin will never
    // start working — it just invites a client hammering the API to "get past"
    // a limit that is not the actual problem.
    return next(forbidden("Request origin is not permitted."));
  }
  next();
};

/**
 * Normalise a client address into a rate-limit bucket key.
 *
 * An IPv6 host is routinely allocated a /64, so keying on the full address
 * would let one client bypass every limit by rotating through its own
 * addresses. Collapsing to the /64 prefix makes the bucket per-subnet, which is
 * the correct granularity: a single residential subscriber presents one prefix.
 *
 * IPv4 and anything unrecognised is returned as-is.
 */
const normalizeIp = (ip: string): string => {
  if (!ip) return "unknown";

  // Strip an IPv4-mapped prefix such as "::ffff:127.0.0.1".
  const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (!mapped.includes(":")) return mapped;

  // Keep only the routing prefix. The /64 boundary sits after the fourth
  // hextet; interface identifiers below that are chosen freely by the client.
  const hextets = mapped.split(":");
  if (hextets.length < 4) return mapped;
  return `${hextets.slice(0, 4).join(":")}::/64`;
};

type KeySource = (req: Request) => string;

const ipKey: KeySource = (req) => normalizeIp(req.ip ?? "");

/**
 * Key authenticated writes by token subject rather than by IP. Behind a shared
 * NAT — an office, a mobile carrier, a university — an IP-based quota would let
 * one noisy client exhaust the allowance for everyone behind the same address.
 * Falls back to the IP when no bearer token is present.
 */
const subjectKey: KeySource = (req) => {
  const auth = req.get("authorization");
  if (auth?.startsWith("Bearer ")) return `sub:${auth.slice("Bearer ".length, "Bearer ".length + 24)}`;
  return `ip:${normalizeIp(req.ip ?? "")}`;
};

/**
 * Shared rate-limit construction.
 *
 * Typed as `Partial<Options>` because that is the input contract of
 * `rateLimit()` in v7 — the exported `Options` type describes the fully
 * resolved configuration, with defaults filled in by the library.
 */
const limit = (
  windowMs: number,
  max: number,
  message: string,
  keyGenerator: KeySource = ipKey,
): Partial<Options> => ({
  windowMs,
  limit: max,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator,
  handler: (_req, _res, next) => next(tooManyRequests(message)),
});

/** Coarse ceiling for the whole surface, to absorb volumetric abuse. */
export const globalLimiter = rateLimit(
  limit(env.rateLimitGlobalWindowMs, env.rateLimitGlobalMax, "Too many requests. Please try again in a minute."),
);

/**
 * Tight limiter on credential endpoints. The exact ceiling is configurable via
 * the environment so the integration suite can be lenient while production stays
 * strict, and the counters stay per-process (the only realistic model for a
 * single-node API). Combined with the per-account lockout in the auth service,
 * online guessing remains impractical.
 */
export const authLimiter = rateLimit(
  limit(env.rateLimitAuthWindowMs, env.rateLimitAuthMax, "Too many authentication attempts. Please try again later."),
);

/**
 * Refresh-token rotation. Deliberately separate from (and looser than) the
 * credential limiter: the SPA calls `/api/auth/refresh` on every page load to
 * restore the session, so sharing the 10-per-15-minute login bucket would let
 * ordinary browsing lock out sign-in. The refresh token is 256-bit and guarded
 * by the CSRF double-submit, so this is DoS protection, not guess resistance.
 */
export const refreshLimiter = rateLimit(
  limit(
    env.rateLimitRefreshWindowMs,
    env.rateLimitRefreshMax,
    "Too many session refreshes. Please wait a moment.",
  ),
);

/** Registration is stricter still — bot-driven signup is the common abuse. */
export const registerLimiter = rateLimit(
  limit(env.rateLimitRegisterWindowMs, env.rateLimitRegisterMax, "Too many accounts created from this address."),
);

/** Checkout is expensive: each call creates a PaymentIntent against Stripe. */
export const checkoutLimiter = rateLimit(
  limit(env.rateLimitCheckoutWindowMs, env.rateLimitCheckoutMax, "Too many checkout attempts. Please wait a moment."),
);

/** Order lookups and catalogue reads sit behind this. */
export const readLimiter = rateLimit(limit(env.rateLimitReadWindowMs, env.rateLimitReadMax, "Too many requests."));

/** Mutations that authenticated users perform at moderate volume. */
export const writeLimiter = rateLimit(
  limit(env.rateLimitWriteWindowMs, env.rateLimitWriteMax, "Too many changes. Please slow down.", subjectKey),
);

/**
 * Unauthenticated public writes — the contact form and the newsletter field in
 * the footer.
 *
 * IP-keyed on purpose: there is no token subject before a visitor has an
 * account, which is the whole point of these endpoints. Tight hourly ceilings are
 * the correct trade because the failure mode is a support queue filled with spam
 * by anyone, and a legitimate visitor sends a handful of messages, not hundreds.
 */
export const contactLimiter = rateLimit(
  limit(
    env.rateLimitContactWindowMs,
    env.rateLimitContactMax,
    "Too many messages sent. Please try again later, or email us directly.",
  ),
);
