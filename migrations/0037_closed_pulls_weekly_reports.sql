CREATE TABLE `closed_pulls` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`merged` integer NOT NULL,
	`opened_at` integer,
	`closed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `closed_pulls_pull` ON `closed_pulls` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `closed_pulls_account_closed` ON `closed_pulls` (`account_id`,`closed_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `report_weekday` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `report_hour` integer DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `report_sent_for` integer;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `weekly` integer DEFAULT false NOT NULL;