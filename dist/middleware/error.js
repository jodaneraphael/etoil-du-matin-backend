import { ZodError } from "zod";
import { AppError, notFound } from "../lib/errors.js";
import { logFault } from "../lib/logger.js";
import { env } from "../env.js";
/** Terminal 404 for unmatched routes. Runs after every router. */
export const notFoundHandler = (req, _res, next) => {
    next(notFound(`No route matches ${req.method} ${req.path}`));
};
/**
 * Centralised error serialisation.
 *
 * The rule: the response body is derived only from values the code chooses to
 * expose. A 5xx never includes `err.message`, because an unexpected message may
 * embed a query fragment, a column name or a connection string. Unexpected
 * errors are logged server-side with their stack and answered with a flat,
 * information-free 500.
 */
export const errorHandler = (err, req, res, next) => {
    // Headers already flushed — the response is committed, so the only correct
    // action is to destroy the socket rather than append a second document.
    if (res.headersSent) {
        return next(err);
    }
    if (err instanceof AppError) {
        if (err.status >= 500) {
            logFault(err, { path: req.path, method: req.method, code: err.code });
        }
        res.status(err.status).json({
            error: {
                code: err.code,
                message: err.message,
                ...(err.details !== undefined && err.expose ? { details: err.details } : {}),
            },
        });
        return;
    }
    // A ZodError escaping a handler means validation was bypassed somewhere.
    // Treated as a client error rather than a server fault.
    if (err instanceof ZodError) {
        res.status(422).json({
            error: {
                code: "validation_failed",
                message: "The request payload failed validation.",
                details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
        });
        return;
    }
    // Body parser rejections arrive as plain errors carrying a status.
    const candidate = err;
    if (candidate?.type === "entity.too.large") {
        res.status(413).json({ error: { code: "payload_too_large", message: "Request body is too large." } });
        return;
    }
    if (candidate?.type === "entity.parse.failed") {
        res.status(400).json({ error: { code: "malformed_json", message: "Request body is not valid JSON." } });
        return;
    }
    logFault(err, { path: req.path, method: req.method });
    res.status(500).json({
        error: {
            code: "internal_error",
            message: "An unexpected error occurred.",
            // Stack traces are useful in development and are a disclosure risk in
            // production, so the flag decides rather than the caller.
            ...(env.isProduction ? {} : { debug: { message: err instanceof Error ? err.message : String(err) } }),
        },
    });
};
//# sourceMappingURL=error.js.map