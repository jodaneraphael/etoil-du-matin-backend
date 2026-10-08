ALTER TABLE `orders` MODIFY COLUMN `status` enum('pending_payment','paid','failed','canceled','partially_refunded','refunded') NOT NULL DEFAULT 'pending_payment';--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `status` enum('requires_payment_method','processing','succeeded','canceled','partially_refunded','refunded') NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `variant_allocations` json DEFAULT (JSON_ARRAY()) NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `stock_released_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `reviews` ADD `moderated_by` char(26);--> statement-breakpoint
ALTER TABLE `reviews` ADD `moderated_at` timestamp(3);