-- Give every `updated_at` column a real `ON UPDATE` clause.
--
-- Drizzle's `$onUpdate` cannot be used for this. It emits no `ON UPDATE` into
-- generated DDL, and it injects its expression into every UPDATE statement, where
-- the raw SQL chunk reaches the timestamp column's `mapToDriverValue` and throws
-- "value.toISOString is not a function" — so it breaks writes while appearing to
-- add nothing. Doing it in DDL instead means the column maintains itself, so a
-- service that forgets to set `updated_at` cannot silently leave it stale.
--
-- `CURRENT_TIMESTAMP(3)` is UTC because db/client.ts pins every pooled session to
-- '+00:00'; MySQL accepts only CURRENT_TIMESTAMP in an ON UPDATE clause, which is
-- why this is not UTC_TIMESTAMP(3).
--
-- The table list mirrors the tables declaring `updatedAt` in src/db/schema.ts.
-- Tables that carry only created_at (order_items, refresh_tokens, reviews,
-- wishlist_items, webhook_events) are intentionally absent.
--
-- The trailing statement-breakpoint markers are required by the Drizzle MySQL
-- reader; without them the whole file is sent as one statement.

ALTER TABLE `addresses` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `cart_items` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `order_fulfillments` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `product_variants` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `products` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `suppliers` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
