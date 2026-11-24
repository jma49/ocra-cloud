CREATE TABLE `review_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_id` text NOT NULL,
	`trace` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_traces_review` ON `review_traces` (`review_id`);--> statement-breakpoint
CREATE INDEX `review_traces_account_created` ON `review_traces` (`account_id`,`created_at`);