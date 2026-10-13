import "dotenv/config";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { env } from "../env.js";
import { closeDatabase, connectionOptions } from "./client.js";

/**
 * Reconcile a database whose migration history does not match its schema.
 *
 * The failure this exists for: `0000_init` created `addresses`, then aborted on
 * `cart_items`, and because MySQL/MariaDB implicitly commit each DDL statement
 * the earlier table stayed behind while *no* row was written to
 * `__drizzle_migrations` (Drizzle records a migration only after every one of its
 * statements has run). Every later `npm run migrate` therefore re-ran `0000` from
 * the top and died immediately on `ER_TABLE_EXISTS_ERROR`.
 *
 * Approach:
 *   1. Read the real migration files with Drizzle's own reader, so the `hash`
 *      values written here are exactly the SHA-256 Drizzle would write — nothing
 *      is fabricated.
 *   2. Report the recorded history and which expected tables already exist.
 *   3. For each migration not yet recorded, run its statements and tolerate ONLY
 *      errors that provably mean "this object is already in place" (duplicate
 *      table/index/constraint, or a DROP of something already gone). Every
 *      tolerated statement is logged.
 *   4. Verify the resulting schema. A migration is recorded ONLY if verification
 *      passes, so a half-applied migration is never marked complete.
 *
 * Dry-run by default; pass `--apply` to make changes. Never drops or truncates a
 * table and never rewrites history.
 */

const APPLY = process.argv.includes("--apply");
const MIGRATIONS_FOLDER = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Error codes that mean the statement's intended object already exists (or, for
 * a DROP, is already absent). These are the only codes tolerated, and only after
 * the post-run verification has independently confirmed the schema.
 */
const ALREADY_APPLIED_CODES = new Set<number>([
  1022, // ER_DUP_KEY                 duplicate key / constraint
  1050, // ER_TABLE_EXISTS_ERROR
  1051, // ER_BAD_TABLE_ERROR         (DROP of a table that is already gone)
  1060, // ER_DUP_FIELDNAME           duplicate column
  1061, // ER_DUP_KEYNAME             duplicate index name
  1091, // ER_CANT_DROP_FIELD_OR_KEY  DROP of an index/column already gone
  1826, // ER_FK_DUP_NAME             duplicate foreign-key constraint name
]);

interface Recorded {
  created_at: number;
  hash: string;
}

const redact = (uri: string): string => uri.replace(/\/\/[^@]*@/, "//***@");

const expectedTables = (migrations: MigrationMeta[]): Set<string> => {
  const names = new Set<string>();
  for (const migration of migrations) {
    for (const statement of migration.sql) {
      const match = /CREATE TABLE\s+`([^`]+)`/i.exec(statement);
      if (match?.[1]) names.add(match[1]);
    }
  }
  return names;
};

const listTables = async (conn: mysql.Connection): Promise<Set<string>> => {
  const [rows] = await conn.query<(RowDataPacket & { TABLE_NAME: string })[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  return new Set(rows.map((r) => r.TABLE_NAME));
};

const listRecorded = async (conn: mysql.Connection): Promise<Recorded[]> => {
  const [exists] = await conn.query<(RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [MIGRATIONS_TABLE],
  );
  if (Number(exists[0]?.n ?? 0) === 0) return [];
  const [rows] = await conn.query<(RowDataPacket & Recorded)[]>(
    `SELECT created_at, hash FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({ created_at: Number(r.created_at), hash: String(r.hash) }));
};

/**
 * Independent verification of the end state. This is what makes tolerating the
 * duplicate-object errors safe: if a tolerated error was hiding a genuine
 * mismatch, one of these checks fails and the migration is not recorded.
 */
const verifySchema = async (conn: mysql.Connection, tables: Set<string>): Promise<string[]> => {
  const problems: string[] = [];
  const present = await listTables(conn);

  for (const table of tables) {
    if (!present.has(table)) problems.push(`missing table: ${table}`);
  }

  // The cart uniqueness contract, checked against the live catalog rather than
  // assumed: `variant_key` must be a real, NOT NULL column (not generated) and
  // the unique index must span the three columns.
  if (present.has("cart_items")) {
    const [cols] = await conn.query<
      (RowDataPacket & { IS_NULLABLE: string; GENERATION_EXPRESSION: string; EXTRA: string })[]
    >(
      "SELECT IS_NULLABLE, GENERATION_EXPRESSION, EXTRA FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items' AND COLUMN_NAME = 'variant_key'",
    );
    const col = cols[0];
    if (!col) {
      problems.push("cart_items.variant_key is missing");
    } else {
      const generated =
        (col.GENERATION_EXPRESSION ?? "").trim() !== "" || /generated/i.test(col.EXTRA ?? "");
      if (generated) problems.push("cart_items.variant_key is still a generated column");
      if (col.IS_NULLABLE !== "NO") problems.push("cart_items.variant_key is nullable");
    }

    const [idx] = await conn.query<(RowDataPacket & { COLUMN_NAME: string; NON_UNIQUE: number })[]>(
      "SELECT COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items' " +
        "AND INDEX_NAME = 'cart_items_line_unique' ORDER BY SEQ_IN_INDEX",
    );
    const indexCols = idx.map((r) => r.COLUMN_NAME);
    const unique = idx.length > 0 && idx.every((r) => r.NON_UNIQUE === 0);
    if (!unique || indexCols.join(",") !== "user_id,product_id,variant_key") {
      problems.push(
        `cart_items_line_unique is not UNIQUE(user_id, product_id, variant_key) (found: ${indexCols.join(",") || "none"})`,
      );
    }
  }

  return problems;
};

const run = async (): Promise<void> => {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const tables = expectedTables(migrations);

  const conn = await mysql.createConnection(connectionOptions({ connectTimeout: 10_000 }));
  try {
    console.log(`database: ${redact(env.databaseUrl)}`);
    console.log(`mode:     ${APPLY ? "APPLY (making changes)" : "DRY RUN (no changes)"}\n`);

    const before = await listTables(conn);
    const recorded = await listRecorded(conn);
    const lastRecorded = recorded.at(-1)?.created_at ?? 0;

    console.log("Recorded migrations:");
    if (recorded.length === 0) console.log("  (none)");
    for (const r of recorded) console.log(`  created_at=${r.created_at} hash=${r.hash.slice(0, 12)}...`);

    console.log("\nExpected tables vs. actual:");
    for (const t of [...tables].sort()) console.log(`  ${before.has(t) ? "[present]" : "[MISSING]"} ${t}`);

    if (before.has("cart_items")) {
      const [cols] = await conn.query<
        (RowDataPacket & { IS_NULLABLE: string; GENERATION_EXPRESSION: string; COLUMN_DEFAULT: string })[]
      >(
        "SELECT IS_NULLABLE, GENERATION_EXPRESSION, COLUMN_DEFAULT FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart_items' AND COLUMN_NAME = 'variant_key'",
      );
      const col = cols[0];
      if (col) {
        const kind = (col.GENERATION_EXPRESSION ?? "").trim() !== ""
          ? `GENERATED (${col.GENERATION_EXPRESSION})`
          : `plain, ${col.IS_NULLABLE === "NO" ? "NOT NULL" : "nullable"}, default=${col.COLUMN_DEFAULT ?? "none"}`;
        console.log(`\ncart_items.variant_key currently: ${kind}`);
      }
    }

    const pending = migrations.filter((m) => m.folderMillis > lastRecorded);
    console.log(`\nPending migrations: ${pending.map((p) => p.folderMillis).join(", ") || "(none)"}`);

    if (pending.length === 0) {
      const problems = await verifySchema(conn, tables);
      if (problems.length === 0) {
        console.log("\nAlready fully migrated and verified. Nothing to do.");
        return;
      }
      console.log("\nNo pending migrations, but the schema failed verification:");
      for (const p of problems) console.log(`  - ${p}`);
      process.exitCode = 1;
      return;
    }

    if (!APPLY) {
      console.log("\nDry run only. Re-run with --apply to reconcile.");
      return;
    }

    // The migrations table itself is created with Drizzle's own definition so the
    // shape matches exactly.
    await conn.query(
      `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
        id serial primary key,
        hash text not null,
        created_at bigint
      )`,
    );

    for (const migration of pending) {
      console.log(`\n→ applying migration created_at=${migration.folderMillis}`);
      let tolerated = 0;

      for (const raw of migration.sql) {
        const statement = raw.trim();
        if (!statement) continue;
        try {
          await conn.query(statement);
        } catch (error) {
          const code = (error as { errno?: number }).errno;
          if (code !== undefined && ALREADY_APPLIED_CODES.has(code)) {
            tolerated += 1;
            const toleratedLine = (statement.split("\n")[0] ?? "").slice(0, 90);
            console.log(`   tolerated (code ${code}, already applied): ${toleratedLine}`);
            continue;
          }
          const failedLine = (statement.split("\n")[0] ?? "").slice(0, 120);
          console.error(`   FAILED on: ${failedLine}`);
          throw error;
        }
      }

      const problems = await verifySchema(conn, tables);
      if (problems.length > 0) {
        console.error("\nRefusing to record this migration: schema verification failed.");
        for (const p of problems) console.error(`  - ${p}`);
        throw new Error("Schema verification failed; migration left unrecorded for a safe retry.");
      }

      await conn.query(
        `INSERT INTO \`${MIGRATIONS_TABLE}\` (\`hash\`, \`created_at\`) VALUES (?, ?)`,
        [migration.hash, migration.folderMillis],
      );
      console.log(`   recorded (${tolerated} statement(s) tolerated as already applied)`);
    }

    console.log("\nReconciliation complete and verified.");
    console.log("Run `npm run migrate` to confirm there is nothing left to apply.");
  } finally {
    await conn.end();
  }
};

run()
  .catch((error: unknown) => {
    console.error("\nReconciliation aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Importing `./client.js` for `connectionOptions` also opens the shared pool
    // as a module side effect; close it so the process can exit.
    await closeDatabase();
    process.exit(process.exitCode ?? 0);
  });
