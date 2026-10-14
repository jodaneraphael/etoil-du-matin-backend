-- Restore the true NULL-ability of every nullable `timestamp` column.
--
-- WHY THIS EXISTS
--
-- The schema declares these columns as nullable (`timestamp("x", { fsp: 3 })`
-- with no `.notNull()`), and on MySQL 8 / `explicit_defaults_for_timestamp=ON`
-- that is exactly what the engine creates: `timestamp(3) NULL DEFAULT NULL`.
--
-- Production runs MariaDB with `explicit_defaults_for_timestamp=OFF` (its
-- default). Under that legacy behaviour a `TIMESTAMP` column that is not
-- explicitly declared `NULL` is silently made `NOT NULL`, and any `TIMESTAMP`
-- column with no explicit `DEFAULT` is given one:
--
--   * the FIRST such column in the table  -> DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
--   * every other one                     -> NOT NULL DEFAULT '0000-00-00 00:00:00.000'
--
-- So a row inserted without a value for one of these columns does not store
-- NULL. It stores either "now" or the zero date, neither of which the
-- application treats as "unset":
--
--   * `refresh_tokens.revoked_at` becomes the zero date, so the presented token
--     looks already-revoked and reuse detection kills the session on the very
--     first refresh ("Refresh token has already been used.").
--   * `sessions.revoked_at` becomes the zero date, so `requireAuth` rejects
--     every request ("Session is no longer valid.").
--
-- MySQL 8 (e.g. the Aiven dev database) keeps these columns nullable, which is
-- why the bug only reproduced on the MariaDB production host.
--
-- The columns below are re-declared with an explicit `NULL DEFAULT NULL` so the
-- engine keeps them nullable regardless of `explicit_defaults_for_timestamp`.
-- The two `NOT NULL` expiry columns keep `NOT NULL` but are given a constant
-- `DEFAULT` so MariaDB stops attaching a spurious `ON UPDATE` (which otherwise
-- re-stamps a password-reset row's expiry the moment its attempt counter is
-- bumped, and re-stamps a refresh token's expiry when it is rotated).
--
-- `created_at` / `updated_at` / `password_changed_at` / `last_seen_at` are
-- intentionally left alone: they are `NOT NULL` with an explicit default, and
-- `updated_at` is supposed to carry `ON UPDATE` (see 0001_updated_at_on_update).
--
-- A follow-up migration must not be needed: prefer fixing the server by setting
-- `explicit_defaults_for_timestamp=ON` where the host allows it. This migration
-- is the belt-and-braces fix for hosts (cPanel) that do not.

-- ── Nullable columns: force `NULL DEFAULT NULL` ────────────────────────────
ALTER TABLE `users` MODIFY COLUMN `email_verified_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `locked_until` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `last_login_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `refresh_tokens` MODIFY COLUMN `revoked_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `sessions` MODIFY COLUMN `revoked_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `password_resets` MODIFY COLUMN `used_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `reviews` MODIFY COLUMN `moderated_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `stock_released_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `placed_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `order_fulfillments` MODIFY COLUMN `forwarded_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `order_fulfillments` MODIFY COLUMN `fulfilled_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `order_fulfillments` MODIFY COLUMN `shipped_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `order_fulfillments` MODIFY COLUMN `delivered_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `webhook_events` MODIFY COLUMN `processed_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `newsletter_subscribers` MODIFY COLUMN `unsubscribed_at` timestamp(3) NULL DEFAULT NULL;--> statement-breakpoint

-- ── NOT NULL expiry columns: keep NOT NULL, drop the spurious ON UPDATE ────
ALTER TABLE `refresh_tokens` MODIFY COLUMN `expires_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `password_resets` MODIFY COLUMN `expires_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);--> statement-breakpoint

-- ── Repair rows already written with the engine's zero-date sentinel ───────
-- Changing a column to nullable does not rewrite existing values, so any row
-- created before this migration still holds '0000-00-00 00:00:00.000' and must
-- be normalised to NULL to match the application's "unset" semantics.
UPDATE `sessions` SET `revoked_at` = NULL WHERE `revoked_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `refresh_tokens` SET `revoked_at` = NULL WHERE `revoked_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `users` SET `locked_until` = NULL WHERE `locked_until` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `users` SET `last_login_at` = NULL WHERE `last_login_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `password_resets` SET `used_at` = NULL WHERE `used_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `reviews` SET `moderated_at` = NULL WHERE `moderated_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `orders` SET `stock_released_at` = NULL WHERE `stock_released_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `order_fulfillments` SET `fulfilled_at` = NULL WHERE `fulfilled_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `order_fulfillments` SET `shipped_at` = NULL WHERE `shipped_at` = '0000-00-00 00:00:00.000';--> statement-breakpoint
UPDATE `order_fulfillments` SET `delivered_at` = NULL WHERE `delivered_at` = '0000-00-00 00:00:00.000';
