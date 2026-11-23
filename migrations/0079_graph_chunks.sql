-- A graph kept in graph_builds.content is not carried over: the next push, or Rebuild, builds it again.
DELETE FROM `graph_builds` WHERE `state` = 'done';--> statement-breakpoint
CREATE TABLE `graph_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`build_id` text NOT NULL,
	`seq` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`build_id`) REFERENCES `graph_builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_chunks_build_seq` ON `graph_chunks` (`build_id`,`seq`);--> statement-breakpoint
CREATE INDEX `graph_chunks_account` ON `graph_chunks` (`account_id`);--> statement-breakpoint
CREATE TABLE `pull_impacts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`graph_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`view` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`graph_repo_id`) REFERENCES `graph_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_impacts_repo_number` ON `pull_impacts` (`graph_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `pull_impacts_account_created` ON `pull_impacts` (`account_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `graph_builds` DROP COLUMN `content`;