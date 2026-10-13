-- Convert `cart_items.variant_key` from a generated column to a plain,
-- application-maintained one.
--
-- Why: MariaDB 10.6 cannot build the required generated column. A STORED
-- expression over the fixed-length `variant_id` char is rejected outright with
-- error 1901 (see MDEV-29777, where `CONCAT(char_col, ...)` STORED fails while
-- the same expression VIRTUAL succeeds), and the original `CASE ... COALESCE`
-- form fails for the same class of reason. Making it VIRTUAL instead only moves
-- the problem: combining a generated column with the foreign key this table
-- needs is itself restricted. The uniqueness guarantee is therefore carried by
-- an ordinary column the service layer keeps in step, with a reserved
-- all-underscore sentinel for "no variant" (underscore is not in the ULID
-- alphabet, so it can never equal a real `product_variants.id`).
--
-- This migration is deliberately data-preserving and safe on every database
-- state this repository can be in:
--   * a fresh database, where 0000 already creates the plain column: the table
--     is empty, so the rebuild only re-establishes the same shape;
--   * a legacy database whose cart_items still carries the old generated column:
--     the UPDATE reproduces exactly the value the expression used to compute.
-- Quantities, ids and every foreign key on the table are left untouched.
--
-- The index is dropped before the column on purpose: dropping a column that is
-- part of a composite UNIQUE index silently leaves a UNIQUE index over the
-- *remaining* columns, which would wrongly forbid more than one cart line per
-- product per user. It is recreated explicitly at the end.

ALTER TABLE `cart_items` DROP INDEX `cart_items_line_unique`;--> statement-breakpoint
ALTER TABLE `cart_items` DROP COLUMN `variant_key`;--> statement-breakpoint
ALTER TABLE `cart_items` ADD `variant_key` char(26) NOT NULL DEFAULT '__________________________';--> statement-breakpoint
UPDATE `cart_items` SET `variant_key` = COALESCE(`variant_id`, '__________________________');--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_line_unique` UNIQUE(`user_id`,`product_id`,`variant_key`);
