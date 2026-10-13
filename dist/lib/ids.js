import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
/**
 * Crockford base32, excluding I, L, O and U to remove transcription ambiguity.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * Draw `count` characters uniformly from a 32-symbol alphabet.
 *
 * `byte & 31` is used rather than `byte % 32`: both are unbiased here only because
 * 256 is an exact multiple of 32, and the mask makes that guarantee structural
 * instead of a coincidence a future edit could break.
 */
const randomChars = (count) => {
    const bytes = randomBytes(count);
    let out = "";
    for (const byte of bytes)
        out += ALPHABET[byte & 31];
    return out;
};
/**
 * Time-ordered id: 10 timestamp characters then 16 random ones.
 *
 * The timestamp prefix keeps primary-key index inserts append-mostly instead of
 * scattering across the B-tree, while the random suffix keeps ids unguessable.
 *
 * Ordering is append-mostly, not strictly monotonic: two ids generated in the
 * same millisecond share a prefix and are then ordered by their random half. That
 * is harmless for index locality, but do not rely on id order to break ties
 * between events — use `createdAt` plus an explicit sequence for that.
 *
 * Entropy is 10 timestamp characters (50 bits) plus 16 random characters
 * (80 bits). Only the random half contributes unguessability, and its leading
 * characters stay zero until the year 10889, so treat the id as ~80 bits rather
 * than 130.
 */
export const newId = () => {
    let time = Date.now();
    let timeChars = "";
    for (let i = 0; i < 10; i++) {
        timeChars = ALPHABET[time % 32] + timeChars;
        time = Math.floor(time / 32);
    }
    return timeChars + randomChars(16);
};
const ORDER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/**
 * Customer-facing order reference. Deliberately excludes 0/O/1/I so it can be read
 * aloud to support.
 *
 * Uses rejection sampling rather than `byte % 31`: 256 is not a multiple of 31, so
 * the modulo form would make the first 8 alphabet symbols each roughly 3% more
 * likely than the rest, shaving entropy off the one value a customer reads out
 * over the phone. Bytes at or above the largest multiple of 31 that fits in a byte
 * (248) are discarded and redrawn.
 */
export const newOrderNumber = () => {
    const limit = 256 - (256 % ORDER_ALPHABET.length); // 248
    let out = "";
    while (out.length < 8) {
        for (const byte of randomBytes(8)) {
            if (byte < limit)
                out += ORDER_ALPHABET[byte % ORDER_ALPHABET.length];
            if (out.length === 8)
                break;
        }
    }
    return `EDM-${out}`;
};
/** 256 bits of entropy, URL-safe. Used for refresh tokens and CSRF values. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const uuid = () => randomUUID();
/**
 * SHA-256 for high-entropy tokens. Fast by design: a token has full entropy,
 * so a memory-hard KDF would add latency without adding security, and a fast
 * hash keeps the token table cheap to scan during lookup.
 */
export const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
export const hmacSha256 = (secret, value) => createHmac("sha256", secret).update(value, "utf8").digest("hex");
/**
 * Constant-time string comparison. Guards against timing oracles that would
 * otherwise let an attacker recover a token or HMAC byte by byte.
 *
 * `timingSafeEqual` throws on length mismatch, which itself leaks length, so
 * both sides are hashed to a fixed 32 bytes before comparison.
 */
export const safeEqual = (a, b) => {
    const bufA = createHash("sha256").update(a, "utf8").digest();
    const bufB = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(bufA, bufB);
};
/**
 * Opaque hash of a network identifier. Storing the hash instead of the raw IP
 * or User-Agent keeps PII out of the database while still allowing
 * "all sessions from this device" lookups.
 */
export const fingerprint = (value) => sha256(value).slice(0, 32);
//# sourceMappingURL=ids.js.map