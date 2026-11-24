CREATE TABLE `pull_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`pushed_at` integer NOT NULL,
	`opened` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_versions_head` ON `pull_versions` (`review_repo_id`,`number`,`head`);--> statement-breakpoint
CREATE INDEX `pull_versions_pull` ON `pull_versions` (`review_repo_id`,`number`,`pushed_at`);--> statement-breakpoint
CREATE INDEX `pull_versions_account_pushed` ON `pull_versions` (`account_id`,`pushed_at`);