CREATE TABLE `paused_pulls` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paused_pulls_pull` ON `paused_pulls` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `paused_pulls_account` ON `paused_pulls` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pull_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`comment_id` text NOT NULL,
	`command` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_commands_comment` ON `pull_commands` (`review_repo_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `pull_commands_account_created` ON `pull_commands` (`account_id`,`created_at`);