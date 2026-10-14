# Incident: users logged out immediately — MariaDB `explicit_defaults_for_timestamp`

**Date:** 2026-10-14
**Area:** Auth / database schema
**Severity:** High — no customer could stay signed in on production
**Status:** Fixed (migration `0006_fix_nullable_timestamps`)

---

## 1. Symptoms

On production (`api.etoile-dumatin.com`, cPanel / MariaDB 10.6.28) a customer
could sign in successfully (login returned `200`) and was then immediately
logged out. The failures were:

- `POST /api/auth/refresh` → `401 {"code":"unauthorized","message":"Refresh token has already been used. Please sign in again."}`
- Any authenticated request (cart, wishlist, addresses, orders) → `401 {"code":"unauthorized","message":"Session is no longer valid."}`

The behaviour was **deterministic** — it happened on the very first refresh,
every time, for every account — and **never reproduced locally**.

Notes that misled the investigation for a while:

- The browser held exactly one `edm_rt` and one `edm_csrf` cookie (no duplicate
  cookies).
- The client-side cross-tab refresh de-duplication (Web Locks) was confirmed
  present in the live bundle.
- A server-side "grace window" for idempotent rotation was deployed and **did
  not help** — because the failure had nothing to do with rotation races.

## 2. Root cause

The MariaDB production host runs with **`explicit_defaults_for_timestamp=OFF`**
(its default). Under this legacy behaviour a `TIMESTAMP` column that is **not
explicitly declared `NULL`** is forced to `NOT NULL`, and any `TIMESTAMP` column
without an explicit `DEFAULT` is given one:

| situation | resulting column |
|---|---|
| first `timestamp` column in the table, no explicit default, declared nullable | `timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` |
| any other `timestamp` column, no explicit default, declared nullable | `timestamp(3) NOT NULL DEFAULT '0000-00-00 00:00:00.000'` |

Drizzle is written for MySQL 8 semantics: `timestamp("revoked_at", { fsp: 3 })`
with no `.notNull()` is meant to be `NULL`-able. Drizzle emits
`revoked_at timestamp(3)` (it does not append the `NULL` keyword), so MariaDB's
legacy mode silently overrides the intent.

Consequence: a row inserted **without** a value for such a column does **not**
store `NULL` — it stores the **zero date** (`0000-00-00 00:00:00.000`) or "now".

The application decides "is this revoked?" with a strict `=== null` check:

- `backend/src/lib/tokens.ts` — reuse detection treats any non-null
  `revoked_at` as an already-used token:
  ```ts
  let row = rows.find((candidate) => candidate.revokedAt === null && ...);
  ...
  const revoked = rows.find((candidate) => candidate.revokedAt !== null);
  if (revoked) { /* revoke family, throw "already been used" */ }
  ```
- `backend/src/middleware/auth.ts` — every session is checked the same way:
  ```ts
  if (!row || row.revokedAt !== null) throw unauthorized("Session is no longer valid.");
  ```

So a refresh token was **born already "revoked"** (the zero date is not `null`),
which killed the session on the first refresh — and every session row was born
"revoked" for the same reason.

## 3. Why it only happened in production

| environment | database | `explicit_defaults_for_timestamp` | result |
|---|---|---|---|
| local dev | Aiven **MySQL 8** | `ON` (MySQL default) | columns stay `NULL DEFAULT NULL` → works |
| production | cPanel **MariaDB 10.6** | `OFF` (MariaDB default) | columns become `NOT NULL DEFAULT '0000-…'` → broken |

Same code, same ORM, same driver — only the engine's default differed.

## 4. How it was found

1. **Reproduced against production from a script** (register → refresh),
   avoiding the browser entirely. The first refresh failed with the exact
   production message, proving it was server-side and not a client/cookie/proxy
   issue.
2. **Differential test.** Running the *same* backend against the MySQL 8 dev
   database succeeded on the first refresh. This isolated the difference to the
   database.
3. **Clean-room reproduction.** A throwaway MariaDB 10.4 instance
   (`explicit_defaults_for_timestamp=0`, matching prod) was initialised, the
   migrations applied, and `SHOW CREATE TABLE refresh_tokens` revealed:
   ```sql
   `revoked_at` timestamp(3) NOT NULL DEFAULT '0000-00-00 00:00:00.000'
   ```
   The app was then run against that database and reproduced the bug exactly.
4. **Fix validated in the clean room first** — `ALTER TABLE … MODIFY COLUMN
   revoked_at timestamp(3) NULL DEFAULT NULL` restored correct behaviour
   (refreshes returned `200`) — and only then was a migration written.

## 5. Blast radius

`explicit_defaults_for_timestamp=OFF` mangled **17** timestamp columns, not
just the two auth ones. All nullable columns the schema declares were affected,
which also silently broke unrelated features:

- `sessions.revoked_at`, `refresh_tokens.revoked_at` — the auth failures above.
- `users.email_verified_at` — every user born "verified" (set to insert time).
- `users.locked_until`, `users.last_login_at` — stored zero date.
- `password_resets.used_at` / `.expires_at` — a wrong reset code bumped
  `attempts`, and the `ON UPDATE` clause reset `expires_at` to "now", instantly
  expiring the code.
- `orders.stock_released_at` — stored zero date, so `isNull(stock_released_at)`
  guards in `stock.service.ts` never matched new orders.
- `orders.placed_at`, `order_fulfillments.forwarded_at/fulfilled_at/shipped_at/delivered_at`,
  `reviews.moderated_at`, `webhook_events.processed_at`,
  `newsletter_subscribers.unsubscribed_at`.

The columns whose default became `CURRENT_TIMESTAMP` happened to line up with
values the application sets explicitly (`placed_at`, `processed_at`,
`forwarded_at`, …), which is why only the `revoked_at` columns produced a
visible outage — the rest were latent.

## 6. The fix

New migration: `backend/drizzle/0006_fix_nullable_timestamps.sql`
(registered in `backend/drizzle/meta/_journal.json`).

1. **Re-declare the 15 nullable columns** with an explicit `NULL DEFAULT NULL`,
   so the engine keeps them nullable regardless of
   `explicit_defaults_for_timestamp`:
   ```sql
   ALTER TABLE `refresh_tokens` MODIFY COLUMN `revoked_at` timestamp(3) NULL DEFAULT NULL;
   ALTER TABLE `sessions`       MODIFY COLUMN `revoked_at` timestamp(3) NULL DEFAULT NULL;
   -- …and the other 13
   ```
2. **Keep `expires_at` `NOT NULL` but drop the spurious `ON UPDATE`** by giving
   it a constant default (the app always supplies a value):
   ```sql
   ALTER TABLE `refresh_tokens`   MODIFY COLUMN `expires_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
   ALTER TABLE `password_resets`  MODIFY COLUMN `expires_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
   ```
3. **Repair existing rows.** Changing a column to nullable does **not** rewrite
   stored values, so pre-existing zero dates must be normalised:
   ```sql
   UPDATE `sessions`       SET `revoked_at` = NULL WHERE `revoked_at` = '0000-00-00 00:00:00.000';
   UPDATE `refresh_tokens` SET `revoked_at` = NULL WHERE `revoked_at` = '0000-00-00 00:00:00.000';
   -- …and the other zero-date columns
   ```

`created_at` / `updated_at` / `password_changed_at` / `last_seen_at` are left
untouched: they are intentionally `NOT NULL` with an explicit default, and
`updated_at` is supposed to carry `ON UPDATE` (see `0001_updated_at_on_update`).

### Deploy

```bash
# on the server, after a database backup
git pull
npm run build
npm run migrate      # applies 0006
# restart the app
```

Because Drizzle only applies migrations newer than the last recorded
`__drizzle_migrations.created_at`, confirm `0000`–`0005` are already recorded
before running.

### Validation performed

- Migration applied to a fresh MariaDB (`explicit_defaults_for_timestamp=0`):
  every affected column is `NULL` afterwards, and register → refresh → refresh
  returns `200`.
- `npm run typecheck` and `npm run build` clean.
- Existing integration suite still passing.

## 7. Prevention / follow-ups

- **Preferred permanent fix:** set `explicit_defaults_for_timestamp=ON` in the
  MariaDB server configuration so the engine matches MySQL 8 semantics. On
  cPanel this may not be available, which is why migration `0006` exists as the
  portable, tracked fix.
- **Do not** rely on Drizzle's implicit nullability for `timestamp` columns on
  MariaDB hosts with the legacy flag. Any new nullable `timestamp` should be
  added with an explicit `DEFAULT NULL` in its migration, or the server flag
  should be fixed first.
- When a bug reproduces only in one environment, compare the **database engine
  and its session/DDL defaults**, not just application code — the same schema
  can be created differently by different engines.
- A throwaway account created during production diagnosis
  (`probe.*@example.com`) can be removed.
