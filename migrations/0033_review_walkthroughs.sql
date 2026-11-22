CREATE TABLE `review_walkthroughs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_id` text NOT NULL,
	`overview` text NOT NULL,
	`groups` text NOT NULL,
	`diagram` text,
	`redacted` integer DEFAULT false NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_walkthroughs_review` ON `review_walkthroughs` (`review_id`);--> statement-breakpoint
CREATE INDEX `review_walkthroughs_account_created` ON `review_walkthroughs` (`account_id`,`created_at`);