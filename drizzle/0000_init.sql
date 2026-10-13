CREATE TABLE `addresses` (
	`id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`label` varchar(60) NOT NULL DEFAULT 'Home',
	`recipient_name` varchar(120) NOT NULL,
	`line1` varchar(160) NOT NULL,
	`line2` varchar(160),
	`city` varchar(100) NOT NULL,
	`postal_code` varchar(20) NOT NULL,
	`country` char(2) NOT NULL,
	`phone` varchar(32),
	`is_default` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `addresses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`variant_id` char(26),
	`variant_key` char(26) GENERATED ALWAYS AS (CASE WHEN variant_id IS NULL THEN '__________________________' ELSE variant_id END) VIRTUAL,
	`quantity` smallint unsigned NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_items_line_unique` UNIQUE(`user_id`,`product_id`,`variant_key`)
);
--> statement-breakpoint
CREATE TABLE `order_fulfillments` (
	`id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`supplier_id` char(26),
	`status` enum('pending','forwarded','fulfilled','shipped','delivered','failed') NOT NULL DEFAULT 'pending',
	`forwarded_reference` varchar(80),
	`tracking_number` varchar(120),
	`tracking_carrier` varchar(80),
	`attempts` smallint unsigned NOT NULL DEFAULT 0,
	`last_error` text,
	`forwarded_at` timestamp(3),
	`fulfilled_at` timestamp(3),
	`shipped_at` timestamp(3),
	`delivered_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_fulfillments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`product_id` char(26),
	`product_name` varchar(200) NOT NULL,
	`product_slug` varchar(160) NOT NULL,
	`variant_id` char(26),
	`variant_label` varchar(120),
	`image_url` varchar(2048) NOT NULL,
	`quantity` smallint unsigned NOT NULL,
	`unit_price_cents` int unsigned NOT NULL,
	`line_total_cents` int unsigned NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` char(26) NOT NULL,
	`order_number` varchar(20) NOT NULL,
	`user_id` char(26),
	`guest_email` varchar(320),
	`guest_claim_token_hash` char(64),
	`shipping_name` varchar(120) NOT NULL,
	`shipping_line1` varchar(160) NOT NULL,
	`shipping_line2` varchar(160),
	`shipping_city` varchar(100) NOT NULL,
	`shipping_postal_code` varchar(20) NOT NULL,
	`shipping_country` char(2) NOT NULL,
	`shipping_phone` varchar(32),
	`currency` char(3) NOT NULL,
	`subtotal_cents` bigint NOT NULL,
	`shipping_cents` bigint NOT NULL,
	`tax_cents` bigint NOT NULL,
	`total_cents` bigint NOT NULL,
	`refunded_cents` bigint NOT NULL DEFAULT 0,
	`status` enum('pending_payment','paid','failed','canceled','refunded') NOT NULL DEFAULT 'pending_payment',
	`idempotency_key` varchar(64) NOT NULL,
	`placed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_order_number_unique` UNIQUE(`order_number`),
	CONSTRAINT `orders_idempotency_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`stripe_payment_intent_id` varchar(64) NOT NULL,
	`status` enum('requires_payment_method','processing','succeeded','canceled','refunded') NOT NULL,
	`amount_cents` bigint NOT NULL,
	`refunded_cents` bigint NOT NULL DEFAULT 0,
	`currency` char(3) NOT NULL,
	`card_last4` char(4),
	`card_brand` varchar(32),
	`failure_code` varchar(64),
	`failure_message` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_pi_unique` UNIQUE(`stripe_payment_intent_id`)
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`sku` varchar(64) NOT NULL,
	`color_name` varchar(60),
	`color_value` varchar(32),
	`size` varchar(32),
	`stock_on_hand` int NOT NULL DEFAULT 0,
	`is_backorderable` boolean NOT NULL DEFAULT false,
	`unit_price_cents` int unsigned,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_variants_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` char(26) NOT NULL,
	`slug` varchar(160) NOT NULL,
	`name` varchar(200) NOT NULL,
	`brand` varchar(120) NOT NULL,
	`unit_price_cents` int unsigned NOT NULL,
	`compare_at_cents` int unsigned,
	`image_url` varchar(2048) NOT NULL,
	`gallery` json NOT NULL,
	`category` enum('Electronics','Fashion','Home & Living','Beauty','Accessories') NOT NULL,
	`gender` enum('men','women','unisex'),
	`subcategory` enum('shoes','clothing','accessories','jewelry','perfumes','marriage','handbags','beauty'),
	`description` text NOT NULL,
	`specs` json NOT NULL,
	`rating_milli` int NOT NULL DEFAULT 0,
	`review_count` int unsigned NOT NULL DEFAULT 0,
	`badge` enum('Best Seller','New','Limited','Sale'),
	`supplier_id` char(26),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`family_id` char(26) NOT NULL,
	`binding_secret_hash` char(64),
	`expires_at` timestamp(3) NOT NULL,
	`revoked_at` timestamp(3),
	`revoked_reason` varchar(64),
	`user_agent_hash` char(64),
	`ip_hash` char(64),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`rating` smallint NOT NULL,
	`title` varchar(160) NOT NULL,
	`body` text NOT NULL,
	`is_approved` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `reviews_user_product_unique` UNIQUE(`product_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`refresh_family_id` char(26) NOT NULL,
	`ip_hash` char(64),
	`user_agent_hash` char(64),
	`last_seen_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`revoked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` char(26) NOT NULL,
	`name` varchar(140) NOT NULL,
	`contact_email` varchar(320) NOT NULL,
	`channel` enum('email','webhook','api') NOT NULL DEFAULT 'webhook',
	`endpoint` varchar(2048) NOT NULL,
	`endpoint_secret` varchar(255),
	`notes` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(26) NOT NULL,
	`email` varchar(320) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`name` varchar(120) NOT NULL,
	`phone` varchar(32),
	`role` enum('customer','admin') NOT NULL DEFAULT 'customer',
	`email_verified_at` timestamp(3),
	`failed_login_attempts` smallint unsigned NOT NULL DEFAULT 0,
	`locked_until` timestamp(3),
	`password_changed_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_login_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` char(26) NOT NULL,
	`stripe_event_id` varchar(64) NOT NULL,
	`type` varchar(80) NOT NULL,
	`status` enum('received','processed','failed','ignored') NOT NULL DEFAULT 'received',
	`error` text,
	`processed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `webhook_events_stripe_id_unique` UNIQUE(`stripe_event_id`)
);
--> statement-breakpoint
CREATE TABLE `wishlist_items` (
	`id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `wishlist_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `wishlist_user_product_unique` UNIQUE(`user_id`,`product_id`)
);
--> statement-breakpoint
ALTER TABLE `addresses` ADD CONSTRAINT `addresses_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_variant_fk` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_fulfillments` ADD CONSTRAINT `order_fulfillments_order_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_fulfillments` ADD CONSTRAINT `order_fulfillments_supplier_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_order_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_supplier_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `addresses_user_idx` ON `addresses` (`user_id`);--> statement-breakpoint
CREATE INDEX `cart_items_user_idx` ON `cart_items` (`user_id`);--> statement-breakpoint
CREATE INDEX `cart_items_product_idx` ON `cart_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `order_fulfillments_order_idx` ON `order_fulfillments` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_fulfillments_supplier_idx` ON `order_fulfillments` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `order_fulfillments_status_idx` ON `order_fulfillments` (`status`);--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_product_idx` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `orders_guest_email_idx` ON `orders` (`guest_email`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `product_variants_product_idx` ON `product_variants` (`product_id`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category`);--> statement-breakpoint
CREATE INDEX `products_gender_sub_idx` ON `products` (`gender`,`subcategory`);--> statement-breakpoint
CREATE INDEX `products_supplier_idx` ON `products` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `products_active_idx` ON `products` (`is_active`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_family_idx` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_expires_idx` ON `refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `reviews_product_idx` ON `reviews` (`product_id`);--> statement-breakpoint
CREATE INDEX `reviews_user_idx` ON `reviews` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_family_idx` ON `sessions` (`refresh_family_id`);--> statement-breakpoint
CREATE INDEX `suppliers_name_idx` ON `suppliers` (`name`);--> statement-breakpoint
CREATE INDEX `suppliers_active_idx` ON `suppliers` (`is_active`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);