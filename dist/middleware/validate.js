import { AppError, validationFailed } from "../lib/errors.js";
/**
 * Parse a value and return it with a field-level error listing on failure.
 * The client receives the shape of what was wrong, never the offending value —
 * echoing input back tends to reproduce it in the response and in any proxy log
 * sitting in between.
 */
const parseOrThrow = (schema, value) => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw validationFailed(result.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            code: issue.code,
            message: issue.message,
        })));
    }
    return result.data;
};
/**
 * Validate and *replace* `req.body` and `req.params` with the parsed result.
 *
 * Replacing rather than merely checking is the point: from here on, a handler
 * holds a value coerced to its declared type with unknown keys stripped, so
 * `req.body.price` is guaranteed to be a number within the declared range and
 * cannot be a string, `null`, or an unexpected object shape.
 *
 * Parsed query values are placed on `res.locals` because Express exposes
 * `req.query` through a getter in v5 and assignment would throw; keeping them
 * off `req` also avoids shadowing an unvalidated copy that a later handler
 * might read by mistake.
 */
export const validateRequest = (schemas) => (req, res, next) => {
    try {
        if (schemas.body)
            req.body = parseOrThrow(schemas.body, req.body);
        if (schemas.params)
            req.params = parseOrThrow(schemas.params, req.params);
        if (schemas.query)
            res.locals.query = parseOrThrow(schemas.query, req.query);
        next();
    }
    catch (error) {
        next(error);
    }
};
/** Read a query value validated by `validateRequest`. */
export const validatedQuery = (_res, _schema) => _res.locals.query;
/** Read a body validated by `validateRequest`. */
export const validatedBody = (req, _schema) => req.body;
/**
 * Read route params validated by `validateRequest`.
 *
 * `req.params` is typed as `Record<string, string>`, so under
 * `noUncheckedIndexedAccess` every lookup widens to `string | undefined` — even
 * after validation has guaranteed the key is present. Casting through the schema
 * resolves the concrete shape and drops the assertion at the call site.
 */
export const params = (req, _schema) => req.params;
/** Narrow `req.auth` for handlers mounted behind `requireAuth`. */
export const requireAuthContext = (req) => {
    if (!req.auth)
        throw new AppError(401, "unauthorized", "Authentication required.");
    return req.auth;
};
/**
 * Wrap an async handler so a rejected promise reaches the error middleware.
 *
 * Express 4 does not await handler return values, so without this an unhandled
 * rejection leaves the request hanging until the socket times out and the
 * client sees a network error instead of a response. With it, a database
 * timeout becomes a prompt 500.
 */
export const asyncHandler = (handler) => (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
};
//# sourceMappingURL=validate.js.map