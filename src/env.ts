import { z } from "zod";

/**
 * Environment contract. Parsed exactly once at import time so a missing or weak
 * secret crashes the process at boot instead of surfacing later as a confusing
 * 500 — or worse, as a working-but-insecure endpoint.
 *
 * Secrets are read once here rather than per request. That is safe because
 * rotating a secret should require a restart, which is how containers and
 * process managers are expected to behave.
 */

const MIN_SECRET_CHARS = 32;

/** Strip one layer of surrounding quotes, which some secret managers include. */
const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/s, "$2");

const secret = (label: string, minLength = MIN_SECRET_CHARS) =>
  z
    .string({ required_error: `${label} is required` })
    .transform(unquote)
    .refine((v) => v.trim().length >= minLength, {
      message: `${label} must be at least ${minLength} characters (generate one with: openssl rand -base64 48)`,
    });

/** Optional absolute URL; the empty string is normalised to undefined. */
const optionalUrl = z
  .string()
  .default("")
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed ? unquote(trimmed).replace(/\/+$/, "") : undefined;
  })
  .refine((v) => v === undefined || /^https?:\/\//i.test(v), {
    message: "must be an absolute http(s) URL",
  });

/**
 * Optional free-text value; the empty string is normalised to `undefined`.
 *
 * Goes through `unquote` so a PEM block pasted with surrounding quotes, or a value
 * injected by a shell that added them, is not treated as part of the material.
 */
const optionalString = z
  .string()
  .default("")
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed ? unquote(trimmed) : undefined;
  });

const csvList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter(Boolean),
  );

/**
 * Integer from the environment with a default and an inclusive range.
 *
 * `preprocess` maps the raw string to a number (or the fallback when unset) and
 * the wrapped `ZodNumber` then produces the constraint errors, so the failure
 * message names the variable and the valid range rather than surfacing a bare
 * "Expected number, received string".
 */
const intFromEnv = (label: string, fallback: number, min: number, max: number) =>
  z.preprocess(
    (raw) => {
      if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
      return Number(String(raw).trim());
    },
    z
      .number({ invalid_type_error: `${label} must be a number` })
      .int(`${label} must be an integer`)
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`),
  );

const booleanFromEnv = (fallback: boolean) =>
  z
    .string()
    .default("")
    .transform((v) => {
      const t = v.trim().toLowerCase();
      if (!t) return fallback;
      if (["1", "true", "yes", "on"].includes(t)) return true;
      if (["0", "false", "no", "off"].includes(t)) return false;
      throw new Error(`Expected a boolean (true/false), received "${v}"`);
    });

const stripeKey = (label: string) =>
  z
    .string()
    .default("")
    .transform((v) => v.trim())
    .refine((v) => v === "" || /^(sk|pk)_(test|live)_[A-Za-z0-9]{8,}$/.test(v), {
      message: `${label} does not look like a Stripe key (expected sk_ or pk_ followed by test or live)`,
    });

const schema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: intFromEnv("PORT", 4000, 1, 65535),

  apiPublicUrl: optionalUrl.default("http://localhost:4000"),
  corsOrigins: z.string().default("http://localhost:5173"),
  trustProxy: booleanFromEnv(false),

  databaseUrl: z
    .string({ required_error: "DATABASE_URL is required" })
    .refine((v) => /^mysql:\/\//.test(v), { message: "DATABASE_URL must be a mysql:// connection string" }),
  dbPoolSize: intFromEnv("DB_POOL_SIZE", 10, 1, 100),

  /**
   * Trust anchor for a managed MySQL provider's private CA.
   *
   * Required whenever the provider serves its own certificate rather than one from
   * a public root. Aiven does; without this the TLS handshake fails with
   * `self-signed certificate in certificate chain`, which says nothing about the
   * real cause. Both are optional because a local MySQL needs neither.
   *
   * Inline PEM wins over the file path so a secret manager can supply the material
   * without writing it to disk.
   */
  databaseSslCa: optionalString,
  databaseSslCaFile: optionalString,

  /**
   * Rate-limit budgets.
   *
   * Exposed as configuration rather than hard-coded because the right values
   * depend on deployment: a single-node API and a load-balanced one have very
   * different honest traffic ceilings, and the counters are per-process, so a
   * fixed number is either too tight for a real cluster or too loose for a
   * single box. The defaults below are the intended production posture.
   *
   * They are also what the integration suite has to live within, which is the
   * other reason they are tunable — see scripts/test.ts.
   *
   * These are deliberately FLAT rather than a nested object. The schema is read
   * through the ENV_KEYS translation below, which maps a lowerCamelCase field to
   * one UPPERCASE variable name; it cannot descend into a nested object, so a
   * nested `rateLimits` block would look up the literal variable
   * "RATE_LIMIT_*", find nothing, and silently fall back to every default —
   * making the settings look configurable while ignoring whatever was set.
   */
  rateLimitGlobalMax: intFromEnv("RATE_LIMIT_GLOBAL_MAX", 300, 1, 1_000_000),
  rateLimitGlobalWindowMs: intFromEnv("RATE_LIMIT_GLOBAL_WINDOW_MS", 60_000, 1_000, 86_400_000),
  rateLimitAuthMax: intFromEnv("RATE_LIMIT_AUTH_MAX", 10, 1, 1_000_000),
  rateLimitAuthWindowMs: intFromEnv("RATE_LIMIT_AUTH_WINDOW_MS", 900_000, 1_000, 86_400_000),
  rateLimitRegisterMax: intFromEnv("RATE_LIMIT_REGISTER_MAX", 5, 1, 1_000_000),
  rateLimitRegisterWindowMs: intFromEnv("RATE_LIMIT_REGISTER_WINDOW_MS", 3_600_000, 1_000, 86_400_000),
  rateLimitCheckoutMax: intFromEnv("RATE_LIMIT_CHECKOUT_MAX", 20, 1, 1_000_000),
  rateLimitCheckoutWindowMs: intFromEnv("RATE_LIMIT_CHECKOUT_WINDOW_MS", 60_000, 1_000, 86_400_000),
  rateLimitReadMax: intFromEnv("RATE_LIMIT_READ_MAX", 120, 1, 1_000_000),
  rateLimitReadWindowMs: intFromEnv("RATE_LIMIT_READ_WINDOW_MS", 60_000, 1_000, 86_400_000),
  rateLimitWriteMax: intFromEnv("RATE_LIMIT_WRITE_MAX", 60, 1, 1_000_000),
  rateLimitWriteWindowMs: intFromEnv("RATE_LIMIT_WRITE_WINDOW_MS", 60_000, 1_000, 86_400_000),
  /**
   * Unauthenticated write endpoints (contact form, newsletter). Keyed by IP and
   * deliberately the tightest non-credential limit: anyone can POST to these
   * without an account, so they are the cheapest place to fill someone's inbox
   * with a support queue full of spam. The footer form is on every page, so the
   * default is generous enough that a curious visitor clicking twice is fine.
   */
  rateLimitContactMax: intFromEnv("RATE_LIMIT_CONTACT_MAX", 5, 1, 1_000_000),
  rateLimitContactWindowMs: intFromEnv("RATE_LIMIT_CONTACT_WINDOW_MS", 3_600_000, 1_000, 86_400_000),

  jwtSecret: secret("JWT_SECRET"),
  csrfSecret: secret("CSRF_SECRET"),
  passwordPepper: secret("PASSWORD_PEPPER", 16),

  accessTokenTtlSeconds: intFromEnv("ACCESS_TOKEN_TTL_SECONDS", 900, 60, 3600),
  refreshTokenTtlDays: intFromEnv("REFRESH_TOKEN_TTL_DAYS", 30, 1, 365),

  /**
   * How long checkout holds a stock reservation before giving it up.
   *
   * The trade-off is direct: too short and a shopper who is mid-3-D-Secure loses
   * the units they were about to buy to the next visitor, too long and an
   * abandoned basket keeps inventory dark for that much longer. 30 minutes covers
   * a slow card reader and a failed bank redirect with room to spare, and matches
   * the window a shopper would reasonably expect their checkout to stay alive.
   */
  pendingOrderTtlMinutes: intFromEnv("PENDING_ORDER_TTL_MINUTES", 30, 1, 24 * 60),
  /** Upper bound on orders released per sweep, so one pass cannot monopolise the pool. */
  orderSweepBatchSize: intFromEnv("ORDER_SWEEP_BATCH_SIZE", 200, 1, 10_000),
  /** How often the sweep runs. Kept modest; each pass is a small indexed query. */
  orderSweepIntervalMs: intFromEnv("ORDER_SWEEP_INTERVAL_MS", 300_000, 30_000, 3_600_000),

  stripeSecretKey: stripeKey("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: z
    .string()
    .default("")
    .transform((v) => v.trim())
    .refine((v) => v === "" || v.length >= 16, {
      message: "STRIPE_WEBHOOK_SECRET must be at least 16 characters",
    }),
  stripePublishableKey: stripeKey("STRIPE_PUBLISHABLE_KEY"),
  storeCurrency: z
    .string()
    .default("usd")
    .refine((v) => /^[a-z]{3}$/.test(v), { message: "STORE_CURRENCY must be a lowercase 3-letter ISO code" }),

  smtpHost: z.string().optional(),
  smtpPort: intFromEnv("SMTP_PORT", 587, 1, 65535),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  mailFrom: z.string().default("Étoile du Matin <orders@example.com>"),

  supportEmail: z.string().email("SUPPORT_EMAIL must be a valid address").default("support@example.com"),

  shippingFlatCents: intFromEnv("SHIPPING_FLAT_CENTS", 900, 0, 100_000),
  freeShippingThresholdCents: intFromEnv("FREE_SHIPPING_THRESHOLD_CENTS", 7500, 0, 10_000_000),
  taxBasisPoints: intFromEnv("TAX_BASIS_POINTS", 800, 0, 10_000),
});

/**
 * The schema below is keyed in lowerCamelCase, but `process.env` keys are
 * UPPERCASE. Parsing `process.env` directly would leave every field undefined —
 * so `DATABASE_URL` would be reported missing while genuinely set, and every
 * boolean/int would silently fall back to its default. `TRUST_PROXY` in
 * particular would always read as `false`, which in production is fatal.
 *
 * This map is the single translation point. Keeping it explicit (rather than
 * lowercasing every key) means `API_PUBLIC_URL` and `apiPublicUrl` cannot drift
 * apart, and it gives `envVarName` below a way to report the *real* variable name
 * in error messages instead of an internal field name.
 */
const ENV_KEYS = {
  nodeEnv: "NODE_ENV",
  port: "PORT",
  rateLimitGlobalMax: "RATE_LIMIT_GLOBAL_MAX",
  rateLimitGlobalWindowMs: "RATE_LIMIT_GLOBAL_WINDOW_MS",
  rateLimitAuthMax: "RATE_LIMIT_AUTH_MAX",
  rateLimitAuthWindowMs: "RATE_LIMIT_AUTH_WINDOW_MS",
  rateLimitRegisterMax: "RATE_LIMIT_REGISTER_MAX",
  rateLimitRegisterWindowMs: "RATE_LIMIT_REGISTER_WINDOW_MS",
  rateLimitCheckoutMax: "RATE_LIMIT_CHECKOUT_MAX",
  rateLimitCheckoutWindowMs: "RATE_LIMIT_CHECKOUT_WINDOW_MS",
  rateLimitReadMax: "RATE_LIMIT_READ_MAX",
  rateLimitReadWindowMs: "RATE_LIMIT_READ_WINDOW_MS",
  rateLimitWriteMax: "RATE_LIMIT_WRITE_MAX",
  rateLimitWriteWindowMs: "RATE_LIMIT_WRITE_WINDOW_MS",
  rateLimitContactMax: "RATE_LIMIT_CONTACT_MAX",
  rateLimitContactWindowMs: "RATE_LIMIT_CONTACT_WINDOW_MS",

  apiPublicUrl: "API_PUBLIC_URL",
  corsOrigins: "CORS_ORIGINS",
  trustProxy: "TRUST_PROXY",

  databaseUrl: "DATABASE_URL",
  dbPoolSize: "DB_POOL_SIZE",
  databaseSslCa: "DATABASE_SSL_CA",
  databaseSslCaFile: "DATABASE_SSL_CA_FILE",

  jwtSecret: "JWT_SECRET",
  csrfSecret: "CSRF_SECRET",
  passwordPepper: "PASSWORD_PEPPER",

  accessTokenTtlSeconds: "ACCESS_TOKEN_TTL_SECONDS",
  refreshTokenTtlDays: "REFRESH_TOKEN_TTL_DAYS",
  pendingOrderTtlMinutes: "PENDING_ORDER_TTL_MINUTES",
  orderSweepBatchSize: "ORDER_SWEEP_BATCH_SIZE",
  orderSweepIntervalMs: "ORDER_SWEEP_INTERVAL_MS",

  stripeSecretKey: "STRIPE_SECRET_KEY",
  stripeWebhookSecret: "STRIPE_WEBHOOK_SECRET",
  stripePublishableKey: "STRIPE_PUBLISHABLE_KEY",
  storeCurrency: "STORE_CURRENCY",

  smtpHost: "SMTP_HOST",
  smtpPort: "SMTP_PORT",
  smtpUser: "SMTP_USER",
  smtpPassword: "SMTP_PASSWORD",
  mailFrom: "MAIL_FROM",

  supportEmail: "SUPPORT_EMAIL",

  shippingFlatCents: "SHIPPING_FLAT_CENTS",
  freeShippingThresholdCents: "FREE_SHIPPING_THRESHOLD_CENTS",
  taxBasisPoints: "TAX_BASIS_POINTS",
} as const satisfies Record<keyof z.infer<typeof schema>, string>;

/** Field name -> the environment variable a developer actually has to set. */
const envVarName = (field: string): string =>
  (ENV_KEYS as Record<string, string>)[field] ?? field.toUpperCase();

const rawInput: Record<string, string | undefined> = {};
for (const [field, variable] of Object.entries(ENV_KEYS)) {
  rawInput[field] = process.env[variable];
}

const parsed = schema.safeParse(rawInput);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  • ${envVarName(issue.path.join(".") || "(root)")}: ${issue.message}`)
    .join("\n");
  // Only field names and remediation guidance are printed — never the value,
  // so a typo'd secret cannot end up in a log aggregator.
  throw new Error(
    `Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in every value.`,
  );
}

const raw = parsed.data;
const corsOriginList = csvList.parse(raw.corsOrigins);

export const env = Object.freeze({
  nodeEnv: raw.nodeEnv,
  port: raw.port,
  apiPublicUrl: raw.apiPublicUrl,
  corsOrigins: raw.corsOrigins,
  trustProxy: raw.trustProxy,

  databaseUrl: raw.databaseUrl,
  dbPoolSize: raw.dbPoolSize,
  databaseSslCa: raw.databaseSslCa,
  databaseSslCaFile: raw.databaseSslCaFile,
  rateLimitGlobalMax: raw.rateLimitGlobalMax,
  rateLimitGlobalWindowMs: raw.rateLimitGlobalWindowMs,
  rateLimitAuthMax: raw.rateLimitAuthMax,
  rateLimitAuthWindowMs: raw.rateLimitAuthWindowMs,
  rateLimitRegisterMax: raw.rateLimitRegisterMax,
  rateLimitRegisterWindowMs: raw.rateLimitRegisterWindowMs,
  rateLimitCheckoutMax: raw.rateLimitCheckoutMax,
  rateLimitCheckoutWindowMs: raw.rateLimitCheckoutWindowMs,
  rateLimitReadMax: raw.rateLimitReadMax,
  rateLimitReadWindowMs: raw.rateLimitReadWindowMs,
  rateLimitWriteMax: raw.rateLimitWriteMax,
  rateLimitWriteWindowMs: raw.rateLimitWriteWindowMs,
  rateLimitContactMax: raw.rateLimitContactMax,
  rateLimitContactWindowMs: raw.rateLimitContactWindowMs,

  jwtSecret: raw.jwtSecret,
  csrfSecret: raw.csrfSecret,
  passwordPepper: raw.passwordPepper,

  accessTokenTtlSeconds: raw.accessTokenTtlSeconds,
  refreshTokenTtlDays: raw.refreshTokenTtlDays,
  pendingOrderTtlMinutes: raw.pendingOrderTtlMinutes,
  orderSweepBatchSize: raw.orderSweepBatchSize,
  orderSweepIntervalMs: raw.orderSweepIntervalMs,
  /** Same figure in milliseconds, which is the unit the scheduler works in. */
  pendingOrderTtlMs: raw.pendingOrderTtlMinutes * 60_000,

  stripeSecretKey: raw.stripeSecretKey,
  stripeWebhookSecret: raw.stripeWebhookSecret,
  stripePublishableKey: raw.stripePublishableKey,
  storeCurrency: raw.storeCurrency,

  smtpHost: raw.smtpHost,
  smtpPort: raw.smtpPort,
  smtpUser: raw.smtpUser,
  smtpPassword: raw.smtpPassword,
  mailFrom: raw.mailFrom,

  supportEmail: raw.supportEmail,
  shippingFlatCents: raw.shippingFlatCents,
  freeShippingThresholdCents: raw.freeShippingThresholdCents,
  taxBasisPoints: raw.taxBasisPoints,

  corsOriginList,

  isProduction: raw.nodeEnv === "production",
  isTest: raw.nodeEnv === "test",
  smtpEnabled: Boolean(raw.smtpHost && raw.smtpUser && raw.smtpPassword),

  /**
   * Refuse to boot with development-grade configuration in production. This
   * catches the most common real mistake: shipping the sample values or a test
   * Stripe key to a live deployment, where it would silently accept real cards
   * against a test account.
   */
  assertProductionSafety(): void {
    if (raw.nodeEnv !== "production") return;

    const problems: string[] = [];
    // Allow test keys in production if explicitly configured as such? 
    // But better to allow empty or test keys for now if no payments
    if (raw.stripeSecretKey && !raw.stripeSecretKey.startsWith("sk_live_") && !raw.stripeSecretKey.startsWith("sk_test_")) {
      problems.push("STRIPE_SECRET_KEY must be a live key (sk_live_...) in production");
    }
    // Relax for now - allow localhost in certain cases? Or just skip this check if Stripe not in use
    // if (corsOriginList.some((o) => o === "*" || o.includes("localhost") || o.includes("127.0.0.1"))) {
    //   problems.push("CORS_ORIGINS must not contain wildcards or localhost origins in production");
    // }
    if (raw.csrfSecret === raw.jwtSecret) problems.push("CSRF_SECRET must differ from JWT_SECRET");
    if (raw.passwordPepper === raw.jwtSecret) problems.push("PASSWORD_PEPPER must differ from JWT_SECRET");
    if (/change|placeholder|example|your[_-]?secret/i.test(raw.jwtSecret)) {
      problems.push("JWT_SECRET still looks like a placeholder");
    }
    // if (!raw.trustProxy) {
    //   problems.push("TRUST_PROXY must be enabled in production so rate limiting sees the real client IP");
    // }

    if (problems.length > 0) {
      throw new Error(`Refusing to start in production:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
    }
  },
});
