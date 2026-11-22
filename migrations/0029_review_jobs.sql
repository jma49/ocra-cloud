CREATE TABLE `review_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer,
	`lease_until` integer,
	`error` text,
	`review_id` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_jobs_pull_head` ON `review_jobs` (`review_repo_id`,`number`,`head`);--> statement-breakpoint
CREATE INDEX `review_jobs_state` ON `review_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_jobs_account_created` ON `review_jobs` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`platform_repo_id` text NOT NULL,
	`full_name` text NOT NULL,
	`webhook_secret_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_repos_platform_repo` ON `review_repos` (`platform`,`host`,`platform_repo_id`);--> statement-breakpoint
CREATE INDEX `review_repos_account` ON `review_repos` (`account_id`);