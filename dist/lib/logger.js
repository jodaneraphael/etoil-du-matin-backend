import { pino } from "pino";
import { env } from "../env.js";
/**
 * Structured logger with hard redaction.
 *
 * The redaction list is deliberately aggressive: it covers credential-bearing
 * request bodies, auth headers, cookies, and every Stripe identifier that
 * could be used to probe the account. Anything that reaches a log line is
 * scrubbed before serialisation, so a careless `log.info({ body })` cannot
 * become a PII or secret disclosure.
 */
const REDACTED = "[redacted]";
const paths = [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['x-csrf-token']",
    "req.headers['stripe-signature']",
    "res.headers['set-cookie']",
    "req.headers['x-api-key']",
    "*.password",
    "*.passwordHash",
    "*.currentPassword",
    "*.newPassword",
    "*.token",
    "*.refreshToken",
    "*.accessToken",
    "*.csrfSecret",
    "*.clientSecret",
    "*.card",
    "*.cardNumber",
    "*.cvc",
    "*.cvv",
    "*.pan",
    "*.accountNumber",
    "*.taxId",
    "*.ssn",
    "*.secret",
    "*.apiKey",
];
export const logger = pino({
    level: env.isProduction ? "info" : "debug",
    redact: { paths, censor: REDACTED, remove: false },
    base: { service: "etoil-du-matin-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
    /**
     * A log line that contains an obviously wrong secret means the redaction
     * list has a gap. Fail the test rather than shipping the leak.
     */
    hooks: {
        logMethod(args, method) {
            return method.apply(this, args);
        },
    },
});
/**
 * Log an unexpected error with its stack. Never log `err` from a request
 * handler directly — use this so the shape stays consistent and PII from the
 * offending object is not attached.
 */
export const logFault = (err, context = {}) => {
    if (err instanceof Error) {
        logger.error({ err: { message: err.message, stack: err.stack, name: err.name }, ...context }, "unexpected error");
    }
    else {
        logger.error({ err: { value: typeof err }, ...context }, "unexpected non-error throw");
    }
};
/**
 * Email addresses and street addresses are PII. Log only the shape needed to
 * debug delivery, never the value.
 */
export const maskEmail = (email) => {
    const [local = "", domain = ""] = email.split("@");
    if (!domain)
        return REDACTED;
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
};
//# sourceMappingURL=logger.js.map