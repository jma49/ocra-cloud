CREATE TABLE `finding_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`thread_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`starter_id` text NOT NULL,
	`state` text,
	`state_by` text,
	`state_at` integer,
	`reason` text,
	`reason_by` text,
	`reason_at` integer,
	`reason_redacted` integer DEFAULT false NOT NULL,
	`reason_truncated` integer DEFAULT false NOT NULL,
	`seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_threads_thread` ON `finding_threads` (`review_repo_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `finding_threads_pull` ON `finding_threads` (`account_id`,`repository`,`number`);--> statement-breakpoint
CREATE INDEX `finding_threads_account_seen` ON `finding_threads` (`account_id`,`seen_at`);