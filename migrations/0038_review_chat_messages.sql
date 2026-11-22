CREATE TABLE `review_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_chat_messages_review` ON `review_chat_messages` (`review_id`);--> statement-breakpoint
CREATE INDEX `review_chat_messages_account_review` ON `review_chat_messages` (`account_id`,`review_id`,`created_at`);