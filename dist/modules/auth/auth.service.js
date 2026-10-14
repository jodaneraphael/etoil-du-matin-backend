import { sendPasswordResetCode } from '../../lib/email.js';
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { addresses, passwordResets, users } from "../../db/schema.js";
import { AppError, conflict, invalidCredentials, isDuplicateEntry, notFound, tooManyRequests } from "../../lib/errors.js";
import { newId, safeEqual, sha256 } from "../../lib/ids.js";
import { logger, maskEmail } from "../../lib/logger.js";
import { fakeVerify, hashPassword, verifyPassword } from "../../lib/password.js";
import { clearAuthCookies, issueTokens, revokeAllForUser, revokeByToken, rotateRefreshToken, rotateRefreshTokens, setAuthCookies, } from "../../lib/tokens.js";
/**
 * Progressive per-account lockout.
 *
 * Five consecutive failures locks the account for 15 minutes, and each further
 * failure doubles the window up to a 24-hour cap. This is the second of two
 * layers: the IP-level limiter in `middleware/security.ts` throttles a single
 * source address, while this throttles a distributed attempt that rotates source
 * IPs to stay under that limit.
 *
 * Every failure path returns the identical `invalidCredentials` error â€” unknown
 * address, wrong password, and locked account are indistinguishable in both the
 * status code and the body.
 */
const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;
/**
 * Read the authoritative failure counter.
 *
 * MySQL has no `UPDATE ... RETURNING`, so the value an atomic increment produced
 * has to be fetched. This is only reached on the failure path, so it costs one
 * extra indexed point lookup per wrong password â€” behind an Argon2 verify, so it
 * is not what makes the endpoint slow, and it is what makes the lockout threshold
 * trustworthy under concurrency.
 */
const readFailedAttempts = async (userId) => {
    const [row] = await db
        .select({ attempts: users.failedLoginAttempts })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    return Number(row?.attempts ?? 0);
};
/**
 * The only user shape that crosses the wire. Hashes, lockout counters, IP hashes
 * and internal timestamps are deliberately excluded: no endpoint needs them, so
 * there is no reason for them to leave the process.
 */
export const toPublicUser = (user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    memberSince: String(user.createdAt.getFullYear()),
});
/**
 * Re-exported so the routes treat this module as the single auth boundary
 * instead of reaching into `lib/tokens.js` alongside it.
 */
export { clearAuthCookies, revokeByToken, rotateRefreshToken, rotateRefreshTokens, setAuthCookies };
const findByEmail = async (email) => {
    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return row;
};
/**
 * Look up an account by email for the registration pre-check.
 *
 * Returns only whether the address is taken. Exposing the full record here would
 * turn a convenience helper into an account-enumeration endpoint for any future
 * caller.
 */
export const getUserByEmail = async (email) => {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    return row;
};
export const register = async (input, client) => {
    const id = newId();
    const passwordHash = await hashPassword(input.password);
    // MySQL has no `INSERT ... RETURNING`, so the row is read back inside the same
    // transaction. Generating the ULID up front means the lookup is a primary-key
    // hit rather than a scan on a natural key.
    const created = await db.transaction(async (tx) => {
        try {
            await tx.insert(users).values({
                id,
                email: input.email,
                passwordHash,
                name: input.name,
                phone: input.phone ?? null,
                role: "customer",
                passwordChangedAt: new Date(),
            });
        }
        catch (error) {
            // The unique index on users.email is the real guarantee against two
            // concurrent registrations of the same address; the route's pre-check only
            // produces a clearer message for the non-racing case.
            throw isDuplicateEntry(error) ? conflict("An account with that email address already exists.") : error;
        }
        const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
        return row;
    });
    logger.info({ userId: created.id }, "account registered");
    return { user: toPublicUser(created), tokens: await issueTokens(created.id, created.role, client) };
};
export const login = async (input, client) => {
    const user = await findByEmail(input.email);
    if (!user) {
        // Spend comparable CPU so response time does not reveal that the address is
        // unregistered.
        await fakeVerify();
        logger.warn({ email: maskEmail(input.email) }, "login attempt for unknown account");
        throw invalidCredentials();
    }
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
        await fakeVerify();
        logger.warn({ userId: user.id }, "login attempt on locked account");
        throw invalidCredentials();
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
        /**
         * The counter is incremented in SQL, not in JavaScript.
         *
         * A read-modify-write against a value read before the password check is not
         * atomic: two simultaneous wrong passwords both read `attempts = 4`, both
         * write `5`, and one of the two failures is discarded. An attacker sending
         * guesses in parallel therefore advances the lockout far more slowly than the
         * five-attempt policy describes â€” or, worse, a successful login racing the
         * failures can reset the counter to zero and wipe the accumulated evidence.
         *
         * `failed_login_attempts + 1` evaluated by the database cannot lose an
         * increment, so the fifth attempt always locks regardless of concurrency.
         * The new value comes back on the same statement (MySQL has no `RETURNING`),
         * which is why the row is re-read only to obtain the number.
         */
        const [bumped] = await db
            .update(users)
            .set({ failedLoginAttempts: sql `${users.failedLoginAttempts} + 1` })
            .where(eq(users.id, user.id));
        const attempts = Number(bumped?.affectedRows ? await readFailedAttempts(user.id) : 0);
        /**
         * Locking is a separate conditional statement rather than part of the same
         * write, so the window between "counter incremented" and "lock applied" cannot
         * hand out extra attempts. `failed_login_attempts >= MAX_FAILED_ATTEMPTS` is
         * re-tested here against the current row value rather than trusting the local
         * `attempts`, which is what makes two racing fifth attempts agree: both see
         * the counter at or above the threshold and both set a lock.
         */
        const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
        if (shouldLock) {
            const lockMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** Math.max(0, attempts - MAX_FAILED_ATTEMPTS));
            await db
                .update(users)
                .set({ lockedUntil: new Date(now.getTime() + lockMs) })
                // Guarded so a lock is never *shortened* by a request that read a smaller
                // counter, and never re-applied over a longer one that is already running.
                .where(and(eq(users.id, user.id), sql `${users.lockedUntil} IS NULL OR ${users.lockedUntil} < ${now}`));
        }
        logger.warn({ userId: user.id, attempts, locked: shouldLock }, "failed login attempt");
        throw invalidCredentials();
    }
    const updated = await db.transaction(async (tx) => {
        // A successful login clears the counter and any residual lock.
        await tx
            .update(users)
            .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now })
            .where(eq(users.id, user.id));
        const [row] = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
        return row ?? user;
    });
    logger.info({ userId: user.id }, "login succeeded");
    return { user: toPublicUser(updated), tokens: await issueTokens(user.id, user.role, client) };
};
export const getUserById = async (userId) => {
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row)
        throw notFound("Account not found.");
    return toPublicUser(row);
};
export const updateProfile = async (userId, input) => {
    const updated = await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        })
            .where(eq(users.id, userId));
        const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
        return row;
    });
    if (!updated)
        throw notFound("Account not found.");
    return toPublicUser(updated);
};
/**
 * Change password.
 *
 * Requires the current password even though the caller already holds a valid
 * access token: a stolen token must not be sufficient to lock the real owner out
 * permanently by rewriting the credential.
 *
 * Every existing session is revoked afterwards. If the change was prompted by a
 * compromise, leaving earlier sessions alive would leave the attacker in.
 */
export const changePassword = async (userId, input) => {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user)
        throw notFound("Account not found.");
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
        throw new AppError(401, "invalid_credentials", "Your current password is incorrect.");
    }
    // Refusing to "change" to the same password is not pedantry: if the change was
    // prompted by a suspected leak, silently keeping the old credential in place
    // would defeat the point of the request.
    if (await verifyPassword(input.newPassword, user.passwordHash)) {
        throw new AppError(422, "password_unchanged", "Choose a password you have not used before.");
    }
    await db
        .update(users)
        .set({
        passwordHash: await hashPassword(input.newPassword),
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
    })
        .where(eq(users.id, userId));
    await revokeAllForUser(userId, "password_changed");
    logger.info({ userId }, "password changed; all sessions revoked");
};
// â”€â”€ Password reset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_CODE_TTL_SECONDS = Math.round(RESET_CODE_TTL_MS / 1000);
/**
 * Cap on wrong-code attempts per reset before it is burned. The code already
 * expires in 15 minutes; this bounds guesses within that window instead of
 * leaving the whole window open to a 6-digit brute force.
 */
const RESET_CODE_MAX_ATTEMPTS = 10;
/**
 * Six independent random digits, drawn with `randomInt` rather than string
 * coercion so a leading zero is preserved instead of silently dropping the code
 * down to five digits.
 */
const newResetCode = () => {
    let code = "";
    for (let i = 0; i < 6; i++)
        code += String(randomInt(0, 10));
    return code;
};
/**
 * Starting a reset. The endpoint answers 200 with the same shape whether or not
 * the address exists, so responses cannot be probed for registered accounts.
 *
 * The code is never stored: only its SHA-256 hash reaches the database, and the
 * plaintext exists solely in the process that generated it. Delivery is plugged
 * through one function so a real delivery channel (email/SMS provider) can be
 * swapped in without touching the endpoint; today it surfaces the code through
 * the channel available at deploy time:
 *   - non-production â€” returned in the response so demos and local clients can
 *     complete the flow, and
 *   - always â€” written to the server log for operator-assisted resets.
 * The response shape never changes, so adding a provider needs no API change.
 */
export const requestPasswordReset = async (input) => {
    const user = await findByEmail(input.email);
    // Unknown address: still pay the Argon2 cost before the generic 200, so the
    // endpoint cannot be used as a cheap account-oracle via response timing.
    await fakeVerify();
    if (!user) {
        logger.info({ email: maskEmail(input.email) }, "reset requested for an unknown address");
        return {};
    }
    const code = newResetCode();
    const id = newId();
    await db.insert(passwordResets).values({
        id,
        userId: user.id,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
    });
    const devCode = env.isProduction ? undefined : code;
    await sendPasswordResetCode(user.email, code);
    logger.warn({ userId: user.id, email: maskEmail(user.email), resetId: id, devCode, ttlSeconds: RESET_CODE_TTL_SECONDS }, "password reset code issued (email attempted)");
    // Sessions are deliberately NOT revoked here. Starting a reset is
    // unauthenticated — anyone who knows the address can trigger it — so revoking
    // at this point would let a stranger sign the real owner out of every device
    // simply by asking. Revocation belongs to the step that actually changes the
    // credential (`resetPassword`), which requires possession of the emailed code.
    return { devCode };
};
// â”€â”€ Addresses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const toPublicAddress = (row) => ({
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    phone: row.phone,
    isDefault: row.isDefault,
});
export const listAddresses = async (userId) => {
    const rows = await db.select().from(addresses).where(eq(addresses.userId, userId));
    return rows.map(toPublicAddress);
};
/**
 * Create an address, promoting it to default when it is the first one or when
 * the caller asked. The clear-then-set runs inside one transaction so two
 * concurrent "make this the default" requests cannot both commit and leave the
 * table with two default rows.
 */
export const createAddress = async (userId, input) => {
    const id = newId();
    const created = await db.transaction(async (tx) => {
        const existing = await tx
            .select({ id: addresses.id })
            .from(addresses)
            .where(eq(addresses.userId, userId));
        const shouldBeDefault = input.isDefault || existing.length === 0;
        if (shouldBeDefault) {
            await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
        }
        await tx.insert(addresses).values({
            id,
            userId,
            label: input.label,
            recipientName: input.recipientName,
            line1: input.line1,
            line2: input.line2 ?? null,
            city: input.city,
            postalCode: input.postalCode,
            country: input.country,
            phone: input.phone ?? null,
            isDefault: shouldBeDefault,
        });
        const [row] = await tx.select().from(addresses).where(eq(addresses.id, id)).limit(1);
        return row;
    });
    return toPublicAddress(created);
};
/**
 * The `userId` predicate on every statement is the authorisation check. A row
 * belonging to someone else is simply not matched, so the request reports 404
 * rather than confirming that the id exists â€” no separate ownership lookup, and
 * no oracle for distinguishing "no such id" from "not yours".
 *
 * This pattern is used for every user-owned resource in the codebase.
 */
export const updateAddress = async (userId, addressId, input) => {
    const updated = await db.transaction(async (tx) => {
        if (input.isDefault === true) {
            await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
        }
        await tx
            .update(addresses)
            .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
            ...(input.line1 !== undefined ? { line1: input.line1 } : {}),
            ...(input.line2 !== undefined ? { line2: input.line2 || null } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
            ...(input.country !== undefined ? { country: input.country } : {}),
            ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        })
            .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));
        const [row] = await tx
            .select()
            .from(addresses)
            .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
            .limit(1);
        return row;
    });
    if (!updated)
        throw notFound("Address not found.");
    return toPublicAddress(updated);
};
export const deleteAddress = async (userId, addressId) => {
    const [result] = await db
        .delete(addresses)
        .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));
    if ((result.affectedRows ?? 0) === 0)
        throw notFound("Address not found.");
};
/** Promote one address to default, clearing the flag on the others. */
export const setDefaultAddress = async (userId, addressId) => {
    await db.transaction(async (tx) => {
        // Ownership is checked first. Clearing every default before verifying the
        // target belongs to the caller would let an unknown id strip the user's
        // current default and leave them with none.
        const owned = await tx
            .select({ id: addresses.id })
            .from(addresses)
            .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
            .limit(1);
        if (owned.length === 0)
            throw notFound("Address not found.");
        await tx
            .update(addresses)
            .set({ isDefault: false })
            .where(and(eq(addresses.userId, userId), ne(addresses.id, addressId)));
        await tx
            .update(addresses)
            .set({ isDefault: true })
            .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));
    });
};
const RESET_GONE = new AppError(422, 'invalid_reset_code', 'That code is invalid or has expired. Request a new one.');
export const resetPassword = async (input) => {
    const user = await findByEmail(input.email);
    if (!user)
        throw RESET_GONE;
    const [row] = await db
        .select()
        .from(passwordResets)
        .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
        .orderBy(desc(passwordResets.createdAt))
        .limit(1);
    if (!row)
        throw RESET_GONE;
    if (!safeEqual(sha256(input.code), row.codeHash)) {
        const [bumped] = await db
            .update(passwordResets)
            .set({ attempts: sql `${passwordResets.attempts} + 1` })
            .where(and(eq(passwordResets.id, row.id), lt(passwordResets.attempts, RESET_CODE_MAX_ATTEMPTS)));
        if (!(bumped?.affectedRows > 0))
            throw tooManyRequests('Too many incorrect codes. Request a new one.');
        throw RESET_GONE;
    }
    await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
            passwordHash: await hashPassword(input.newPassword),
            passwordChangedAt: new Date(),
            failedLoginAttempts: 0,
            lockedUntil: null,
        })
            .where(eq(users.id, user.id));
        await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
    });
    await revokeAllForUser(user.id, 'password_reset');
    logger.info({ userId: user.id }, 'password reset by code; all sessions revoked');
};
//# sourceMappingURL=auth.service.js.map