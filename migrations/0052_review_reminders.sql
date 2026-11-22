CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`reviewer_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`done_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_pull_reviewer` ON `review_requests` (`review_repo_id`,`number`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `review_requests_account_requested` ON `review_requests` (`account_id`,`requested_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `time_zone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `reminder_hours` integer;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `quiet_start` integer;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `quiet_end` integer;