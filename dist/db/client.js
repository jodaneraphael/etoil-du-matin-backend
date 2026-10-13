import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import * as schema from "./schema.js";
/**
 * Work out the TLS settings for a `DATABASE_URL`.
 *
 * mysql2 does **not** understand `ssl-mode`. That spelling is Connector/J's, and
 * mysql2's URI parser discards it with only a warning:
 *
 *     Ignoring invalid configuration option passed to Connection: ssl-mode
 *
 * which is the worst kind of failure — the URL says `REQUIRED`, the connection is
 * silently plaintext, and nothing errors. Verified against Aiven: with
 * `?ssl-mode=REQUIRED` in the URL, `SHOW STATUS LIKE 'Ssl_cipher'` came back empty,
 * meaning the DB password and every query crossed the network unencrypted to a
 * remote host. Passing `?ssl=true` does not help either — mysql2 wants an object
 * and rejects a boolean outright ("SSL profile must be an object").
 *
 * So the query string is translated into a real `ssl` profile here, and TLS is the
 * default for anything that is not loopback. Opting out has to be explicit
 * (`ssl-mode=DISABLED`), because the previous behaviour was "silently insecure
 * unless you knew the secret incantation".
 *
 * `rejectUnauthorized` stays on. That is the entire point of enabling TLS: turning
 * it off would encrypt the channel while removing the only defence against an
 * active MITM, which is a false sense of security rather than security.
 *
 * Managed MySQL providers generally serve certificates from their own private CA
 * rather than a public root — Aiven's does, and a handshake against it with only
 * the system trust store fails with `self-signed certificate in certificate
 * chain`. The CA is therefore supplied out of band via `DATABASE_SSL_CA` (PEM text)
 * or `DATABASE_SSL_CA_FILE` (a path), downloaded from the provider's dashboard.
 * Verification then succeeds against a CA the operator has explicitly chosen.
 */
const resolveSsl = (uri) => {
    const host = safeHost(uri);
    const loopback = host !== null && /^(localhost|127\.0\.0\.1|::1)$/.test(host);
    const mode = (() => {
        try {
            // `URL` handles userinfo percent-encoding correctly, which matters because a
            // password containing `@` or `#` would otherwise truncate the host.
            return new URL(uri).searchParams.get("ssl-mode")?.toUpperCase() ?? null;
        }
        catch {
            // An unparseable URL is the driver's problem to report, not this one's.
            return null;
        }
    })();
    if (mode === "DISABLED") {
        if (!loopback) {
            throw new Error("DATABASE_URL disables TLS for a non-loopback host. Refusing to start: the " +
                "database password and all query traffic would cross the network in plaintext.");
        }
        return undefined;
    }
    /**
     * Loopback defaults to no TLS.
     *
     * The overwhelmingly common local setup is a MySQL container or a workstation
     * server with no certificate at all, so demanding TLS there would just make the
     * app refuse to start against a database that is not exposed to anything. The
     * traffic never leaves the machine, so there is nothing to protect. Loopback that
     * *does* offer TLS can still ask for it with `?ssl-mode=REQUIRED`.
     */
    if (loopback && mode === null)
        return undefined;
    return {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...loadTrustAnchor(),
    };
};
const safeHost = (uri) => {
    try {
        return new URL(uri).hostname;
    }
    catch {
        return null;
    }
};
/**
 * Read the operator-supplied trust anchor for a managed provider's private CA.
 *
 * `DATABASE_SSL_CA` carries the PEM inline (handy for a secret manager, and the
 * reason it is checked first), `DATABASE_SSL_CA_FILE` points at a file on disk.
 * A path that cannot be read throws rather than degrading to the system trust
 * store, because the resulting handshake error ("self-signed certificate in
 * certificate chain") gives no hint that a mistyped path is the cause.
 */
const loadTrustAnchor = () => {
    const inline = env.databaseSslCa?.trim();
    if (inline)
        return { ca: inline };
    const file = env.databaseSslCaFile?.trim();
    if (file)
        return { ca: readFileSync(file, "utf8") };
    return {};
};
/**
 * Strip query parameters mysql2 will misparse or ignore.
 *
 * `ssl-mode` is removed because it is meaningless to the driver and its presence
 * is what produces the misleading "invalid configuration option" warning. It has
 * already been consumed by `resolveSsl`. Everything else is left alone so that
 * mysql2's own supported parameters keep working.
 */
const withoutSslMode = (uri) => {
    try {
        const url = new URL(uri);
        url.searchParams.delete("ssl-mode");
        return url.toString();
    }
    catch {
        return uri;
    }
};
/**
 * Connection options derived from `DATABASE_URL`, for callers that open their own
 * connection instead of using the shared pool (notably `db:migrate`).
 *
 * Exported so the TLS translation has exactly one implementation. When the migrate
 * script built its connection straight from the raw URL it silently reconnected in
 * plaintext, because `ssl-mode` is inert to mysql2 - the app would be encrypted
 * while migrations quietly were not.
 */
export const connectionOptions = (overrides = {}) => ({
    uri: withoutSslMode(env.databaseUrl),
    ssl: resolveSsl(env.databaseUrl),
    ...overrides,
});
/**
 * Connection pool.
 *
 * `multipleStatements` is deliberately left at its default (false). With it
 * enabled, a single value containing an unescaped semicolon could terminate
 * one statement and append an arbitrary second one, turning any missed
 * parameterisation into full injection. Nothing in this codebase issues
 * multi-statement SQL.
 */
export const pool = mysql.createPool({
    ...connectionOptions(),
    connectionLimit: env.dbPoolSize,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // Return DECIMAL/BIGINT as strings rather than lossy JS numbers unless
    // explicitly configured, so money never silently loses precision in transit.
    decimalNumbers: true,
    // "Z" makes the driver read and write DATETIME as UTC.
    timezone: "Z",
    charset: "utf8mb4",
});
pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
        if (error) {
            logger.error({ err: error }, "failed to pin session time_zone to UTC");
        }
    });
});
export const db = drizzle(pool, { schema, mode: "default" });
/**
 * Assert that the session really is UTC.
 *
 * The `SET` above is fire-and-forget, so it can in principle be racing the first
 * query on a brand new connection. Rather than trust it, this checks the
 * effective offset once at boot and refuses to start if the database would hand
 * back server-local timestamps — a wrong `created_at` is far harder to notice
 * later than a failed boot.
 */
export const assertUtcSession = async () => {
    const [rows] = await pool.query("SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(3), NOW(3)) AS offset_minutes");
    const offset = Number(rows?.[0]?.offset_minutes ?? 0);
    if (offset !== 0) {
        throw new Error(`Database session time zone is not UTC (offset ${offset} minutes). ` +
            "Refusing to start: server-generated timestamps would disagree with " +
            "application-written timestamps.");
    }
    logger.info("database session confirmed UTC");
};
/**
 * Verify connectivity at boot. Failing fast beats accepting traffic that will
 * error on every query — and, more importantly, makes a misconfigured
 * DATABASE_URL obvious immediately instead of at the first checkout.
 */
export const assertDatabaseConnection = async () => {
    const started = Date.now();
    try {
        await pool.query("SELECT 1");
        logger.info({ durationMs: Date.now() - started }, "database connection established");
    }
    catch (error) {
        logger.error({ err: error }, "database connection failed");
        throw error;
    }
};
export const closeDatabase = async () => {
    await pool.end();
};
//# sourceMappingURL=client.js.map