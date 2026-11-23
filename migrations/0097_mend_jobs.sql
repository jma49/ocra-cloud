CREATE TABLE `mend_items` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`job_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`outcome` text,
	`reason` text,
	`commit_sha` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `mend_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mend_items_account_finding` ON `mend_items` (`account_id`,`finding_id`);--> statement-breakpoint
CREATE INDEX `mend_items_job` ON `mend_items` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mend_items_finding` ON `mend_items` (`finding_id`);--> statement-breakpoint
CREATE TABLE `mend_jobs` (
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
	`outcome` text,
	`commit_sha` text,
	`loop` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mend_jobs_pull` ON `mend_jobs` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `mend_jobs_state` ON `mend_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `mend_jobs_account_repo` ON `mend_jobs` (`account_id`,`review_repo_id`,`number`);--> statement-breakpoint
ALTER TABLE `review_repos` ADD `mend` text DEFAULT 'propose' NOT NULL;