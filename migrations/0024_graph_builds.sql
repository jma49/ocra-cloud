CREATE TABLE `graph_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`graph_repo_id` text NOT NULL,
	`commit` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer,
	`lease_until` integer,
	`error` text,
	`content` blob,
	`bytes` integer,
	`files` integer,
	`parsed` integer,
	`reused` integer,
	`skipped` integer,
	`truncated` integer DEFAULT false NOT NULL,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`graph_repo_id`) REFERENCES `graph_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_builds_repo_commit` ON `graph_builds` (`graph_repo_id`,`commit`);--> statement-breakpoint
CREATE INDEX `graph_builds_state` ON `graph_builds` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `graph_builds_account_created` ON `graph_builds` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `graph_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`platform_repo_id` text NOT NULL,
	`full_name` text NOT NULL,
	`branch` text NOT NULL,
	`webhook_secret_hash` text,
	`consented_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_repos_account_repo` ON `graph_repos` (`account_id`,`platform`,`host`,`platform_repo_id`);--> statement-breakpoint
CREATE INDEX `graph_repos_platform_repo` ON `graph_repos` (`platform`,`host`,`platform_repo_id`);