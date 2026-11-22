CREATE TABLE `review_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`scope` text NOT NULL,
	`review_repo_id` text,
	`first_review_hours` integer,
	`merge_days` integer,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_targets_account_scope` ON `review_targets` (`account_id`,`scope`);--> statement-breakpoint
CREATE INDEX `review_targets_repo` ON `review_targets` (`review_repo_id`);