CREATE TABLE `restack_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`parent_merge` text NOT NULL,
	`parent` integer NOT NULL,
	`branch` text NOT NULL,
	`head` text NOT NULL,
	`onto_branch` text NOT NULL,
	`onto_commit` text,
	`upstream` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`outcome` text,
	`restacked_to` text,
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
CREATE UNIQUE INDEX `restack_jobs_pull_merge` ON `restack_jobs` (`review_repo_id`,`number`,`parent_merge`);--> statement-breakpoint
CREATE INDEX `restack_jobs_state` ON `restack_jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `restack_jobs_account_repo` ON `restack_jobs` (`account_id`,`review_repo_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `review_repos` ADD `restack` integer DEFAULT false NOT NULL;