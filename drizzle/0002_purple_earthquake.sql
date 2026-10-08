CREATE TABLE `contact_messages` (
	`id` char(26) NOT NULL,
	`user_id` char(26),
	`name` varchar(120) NOT NULL,
	`email` varchar(254) NOT NULL,
	`topic` enum('order_support','product_question','returns','partnerships','other') NOT NULL DEFAULT 'other',
	`message` text NOT NULL,
	`status` enum('new','read','archived') NOT NULL DEFAULT 'new',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `contact_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `newsletter_subscribers` (
	`id` char(26) NOT NULL,
	`email` varchar(254) NOT NULL,
	`user_id` char(26),
	`is_active` boolean NOT NULL DEFAULT true,
	`unsubscribed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `newsletter_subscribers_id` PRIMARY KEY(`id`),
	CONSTRAINT `newsletter_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `contact_messages_created_idx` ON `contact_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `contact_messages_status_idx` ON `contact_messages` (`status`);--> statement-breakpoint
CREATE INDEX `contact_messages_user_idx` ON `contact_messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `newsletter_user_idx` ON `newsletter_subscribers` (`user_id`);