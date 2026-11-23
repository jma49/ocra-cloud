CREATE TABLE `learn_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`again` integer DEFAULT false NOT NULL,
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
CREATE UNIQUE INDEX `learn_jobs_pull` ON `learn_jobs` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `learn_jobs_state` ON `learn_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `learn_jobs_account_repo` ON `learn_jobs` (`account_id`,`review_repo_id`,`finished_at`);--> statement-breakpoint
ALTER TABLE `review_repos` ADD `learn` text DEFAULT 'merge' NOT NULL;