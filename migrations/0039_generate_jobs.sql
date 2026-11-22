CREATE TABLE `generate_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`kind` text NOT NULL,
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
CREATE UNIQUE INDEX `generate_jobs_pull_head_kind` ON `generate_jobs` (`review_repo_id`,`number`,`head`,`kind`);--> statement-breakpoint
CREATE INDEX `generate_jobs_state` ON `generate_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `generate_jobs_account_pull` ON `generate_jobs` (`account_id`,`review_repo_id`,`number`);