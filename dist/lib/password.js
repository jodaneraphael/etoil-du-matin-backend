import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { env } from "../env.js";
/**
 * Argon2id parameters follow the OWASP Password Storage Cheat Sheet
 * recommendation (19 MiB memory, 2 iterations, parallelism 1). The library
 * embeds these in the PHC string, so the cost can be raised later without
 * invalidating existing passwords — `verify` reads the parameters from the
 * stored hash rather than from the options passed in.
 *
 * Why a pepper on top of the KDF: Argon2id protects against GPU cracking, but
 * a stolen database dump is still brute-forceable offline. Mixing in
 * PASSWORD_PEPPER means the dump alone is useless — the attacker also needs
 * the value held only in the process environment.
 */
const ARGON_OPTIONS = {
    algorithm: 2 /* Algorithm.Argon2id */,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
};
export const hashPassword = async (plaintext) => hash(`${plaintext}${env.passwordPepper}`, ARGON_OPTIONS);
/**
 * Verify a password.
 *
 * Note the argument order: `verify(hashed, password)`. The encoded PHC string is
 * the FIRST argument and the candidate password is the second. Passing them the
 * other way round compiles cleanly and throws no error, but silently returns
 * false for every password, so no login can ever succeed.
 *
 * `options` is deliberately omitted. The cost parameters are embedded in the
 * stored PHC string and are read from it, which is what allows existing hashes
 * to keep verifying after the policy below is strengthened.
 *
 * Never throws: a corrupt or foreign-format stored hash is treated as a failed
 * login rather than a 500. Leaking a distinct error for a malformed hash would
 * itself be an oracle for distinguishing users.
 */
export const verifyPassword = async (plaintext, storedHash) => {
    try {
        return await verify(storedHash, `${plaintext}${env.passwordPepper}`);
    }
    catch {
        return false;
    }
};
/**
 * A real Argon2id hash of a random throwaway value, produced once per process.
 *
 * Used to equalise login latency: when no account matches the supplied email,
 * the handler still performs a full verification against this hash. Without it,
 * "unknown email" returns in ~1 ms while "wrong password" takes ~50 ms, which is
 * a clean account-enumeration oracle even though the messages are identical.
 *
 * Generated rather than hard-coded so it is guaranteed to be a well-formed PHC
 * string that costs the same as a genuine verification.
 */
let dummyHashPromise;
const getDummyHash = () => {
    dummyHashPromise ??= hash(randomBytes(32).toString("hex"), ARGON_OPTIONS).catch(() => {
        // If hashing is unavailable the timing equalisation degrades, but login
        // must still work. Reset so a later attempt can retry.
        dummyHashPromise = undefined;
        return "";
    });
    return dummyHashPromise;
};
export const fakeVerify = async () => {
    const dummy = await getDummyHash();
    if (!dummy)
        return;
    await verify(dummy, randomBytes(32).toString("hex")).catch(() => undefined);
};
/**
 * Constant-time work factor for the hash side of a login attempt. Derived from
 * a stored hash so the cost tracks the account's actual Argon2 parameters.
 */
export const burnVerification = async (storedHash) => {
    await verify(storedHash, randomBytes(32).toString("hex")).catch(() => undefined);
};
//# sourceMappingURL=password.js.map