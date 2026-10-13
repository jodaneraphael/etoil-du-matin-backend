/**
 * Error taxonomy. Anything thrown that is not an AppError is treated as an
 * unexpected fault by the error middleware and reported to the client as a
 * generic 500, so internal details (SQL fragments, stack traces, file paths)
 * can never leak through a handler that forgets to catch.
 */
export class AppError extends Error {
    status;
    code;
    details;
    /** Marks errors as safe to describe in the HTTP response body. */
    expose;
    constructor(status, code, message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "AppError";
        this.status = status;
        this.code = code;
        this.details = options?.details;
        this.expose = status < 500;
        Error.captureStackTrace?.(this, AppError);
    }
}
export const badRequest = (message, details) => new AppError(400, "bad_request", message, { details });
export const validationFailed = (details) => new AppError(422, "validation_failed", "The request payload failed validation.", { details });
export const unauthorized = (message = "Authentication required.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have access to this resource.") => new AppError(403, "forbidden", message);
export const notFound = (message = "Resource not found.") => new AppError(404, "not_found", message);
/**
 * Used for auth failures where revealing the cause would let an attacker
 * distinguish registered from unregistered accounts. Returns an identical
 * shape and timing profile for both cases.
 */
export const invalidCredentials = () => new AppError(401, "invalid_credentials", "Incorrect email or password.");
export const conflict = (message) => new AppError(409, "conflict", message);
export const tooManyRequests = (message = "Too many requests. Please slow down.") => new AppError(429, "rate_limited", message);
export const paymentFailed = (message) => new AppError(402, "payment_failed", message);
export const serviceUnavailable = (message = "Service temporarily unavailable.") => new AppError(503, "service_unavailable", message);
/**
 * True when MySQL reported a unique-constraint violation (ER_DUP_ENTRY).
 *
 * Callers use this to turn a race they lost into a clean 409. A pre-flight
 * "does this exist?" check narrows the common case for a nicer message, but it
 * cannot close the window between the check and the insert — only the database
 * constraint can, and this is how the losing caller learns it lost.
 */
export const isDuplicateEntry = (error) => typeof error === "object" && error !== null && error.code === "ER_DUP_ENTRY";
//# sourceMappingURL=errors.js.map