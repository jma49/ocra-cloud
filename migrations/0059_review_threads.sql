CREATE TABLE `review_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`thread_key` text NOT NULL,
	`starter_id` text NOT NULL,
	`starter_login` text NOT NULL,
	`started_at` integer NOT NULL,
	`replied_at` integer,
	`starter_replied_at` integer,
	`seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_threads_thread` ON `review_threads` (`review_repo_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `review_threads_pull` ON `review_threads` (`review_repo_id`,`number`,`starter_id`);--> statement-breakpoint
CREATE INDEX `review_threads_account_seen` ON `review_threads` (`account_id`,`seen_at`);