CREATE TABLE `pull_paths` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`prefix` text NOT NULL,
	`seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_paths_prefix` ON `pull_paths` (`review_repo_id`,`number`,`prefix`);--> statement-breakpoint
CREATE INDEX `pull_paths_account_seen` ON `pull_paths` (`account_id`,`seen_at`);