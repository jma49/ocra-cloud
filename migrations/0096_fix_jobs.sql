CREATE TABLE `fix_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`finding_id` text NOT NULL,
	`head` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`outcome` text,
	`reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer,
	`lease_until` integer,
	`error` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fix_jobs_account_finding_head` ON `fix_jobs` (`account_id`,`finding_id`,`head`);--> statement-breakpoint
CREATE INDEX `fix_jobs_state` ON `fix_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `fix_jobs_account_pull` ON `fix_jobs` (`account_id`,`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `fix_jobs_finding` ON `fix_jobs` (`finding_id`);--> statement-breakpoint
ALTER TABLE `findings` ADD `low_confidence` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `evidence` text;