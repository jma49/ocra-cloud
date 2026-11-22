CREATE TABLE `merge_check_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`conclusion` text NOT NULL,
	`results` text NOT NULL,
	`digest` text NOT NULL,
	`posted_digest` text,
	`external_id` text,
	`posted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_check_runs_head` ON `merge_check_runs` (`review_repo_id`,`number`,`head`);--> statement-breakpoint
CREATE INDEX `merge_check_runs_account_created` ON `merge_check_runs` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `merge_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merge_checks_repo` ON `merge_checks` (`review_repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `merge_checks_account` ON `merge_checks` (`account_id`);--> statement-breakpoint
ALTER TABLE `reviews` ADD `linked_tasks` text;