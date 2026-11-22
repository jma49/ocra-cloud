CREATE TABLE `reply_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`comment_id` text NOT NULL,
	`inline` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer,
	`lease_until` integer,
	`error` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_jobs_comment` ON `reply_jobs` (`review_repo_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `reply_jobs_state` ON `reply_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `reply_jobs_account_created` ON `reply_jobs` (`account_id`,`created_at`);