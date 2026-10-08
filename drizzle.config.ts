import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * `DATABASE_URL` is optional here because `drizzle-kit generate` is a purely
 * offline operation — it diffs the schema files and writes SQL, and never opens a
 * connection. Requiring a real URL for it would mean migrations cannot be
 * generated on a machine that has no database, which is most CI runners.
 *
 * When the variable is absent a deliberately unresolvable URL is substituted.
 * `.invalid` is a reserved TLD guaranteed never to resolve (RFC 2606), so any
 * command that *does* connect — `push`, `studio`, `migrate` — fails loudly and
 * immediately instead of reaching a real server. That matters: a fallback like
 * `127.0.0.1` could silently target a developer's local database when they
 * believed they were pointed at staging.
 *
 * `db:migrate` does not go through this file at all — `src/db/migrate.ts`
 * validates the environment through `src/env.ts` first.
 */
const url = process.env.DATABASE_URL ?? "mysql://unset:unset@unreachable.invalid:3306/unset";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
