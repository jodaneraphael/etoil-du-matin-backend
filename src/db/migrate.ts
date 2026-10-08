import "dotenv/config";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { connectionOptions } from "./client.js";

/**
 * Apply pending migrations.
 *
 * Runs as its own entry point rather than at application boot, so that a
 * deployment is an explicit, auditable step: the app never attempts DDL against
 * whatever database it happens to be pointed at, and a failed migration leaves
 * the previous schema intact rather than half-applied by a crashed process.
 *
 * Uses `env.databaseUrl`, not a separate migration credential, so the value
 * cannot drift from what the application itself uses. If a deployment wants DDL
 * rights separated from runtime rights, point this script at a different
 * `DATABASE_URL` when invoking it.
 *
 * The connection is built from `connectionOptions()` rather than the raw URL, so
 * migrations get the same TLS translation as the application. Taking `uri`
 * straight from `env.databaseUrl` here connected in plaintext, because `ssl-mode`
 * is silently ignored by mysql2 - the app would have been encrypted while
 * migrations were not.
 *
 * A note on failure behaviour: Drizzle wraps each migration in a transaction,
 * but MySQL performs an implicit commit before and after every DDL statement, so
 * that transaction cannot actually roll back a half-applied migration. A failed
 * run leaves partial tables behind and the next attempt fails on
 * ER_TABLE_EXISTS_ERROR. Recover by restoring the previous backup, or on a
 * throwaway database by dropping and recreating it. Migrations are therefore
 * written to be additive and re-runnable rather than assumed atomic.
 */
const run = async (): Promise<void> => {
  const connection = await mysql.createConnection(
    connectionOptions({
      // Migrations can run for a while on a large schema; the pool default of 10s
      // is not the right ceiling for DDL.
      connectTimeout: 10_000,
    }),
  );

  try {
    const db = drizzle(connection);
    logger.info({ database: env.databaseUrl.replace(/\/\/[^@]*@/, "//***@") }, "applying migrations");
    await migrate(db, { migrationsFolder: "./drizzle" });
    logger.info("migrations applied");
  } finally {
    await connection.end();
  }
};

run().catch((error: unknown) => {
  logger.fatal({ err: error }, "migration failed");
  process.exit(1);
});
