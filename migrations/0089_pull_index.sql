CREATE TABLE `pull_index` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`pull_id` text,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`author` text,
	`author_id` text,
	`author_avatar` text,
	`draft` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`opened_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`merged_at` integer,
	`closed_at` integer,
	`labels` text NOT NULL,
	`additions` integer,
	`deletions` integer,
	`head` text,
	`head_branch` text,
	`base_branch` text,
	`reviewer_ids` text NOT NULL,
	`assignee_ids` text NOT NULL,
	`checks` text,
	`review` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_index_pull` ON `pull_index` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `pull_index_account_state` ON `pull_index` (`account_id`,`state`,`changed_at`);--> statement-breakpoint
ALTER TABLE `platform_links` ADD `pulls_verified_at` integer;--> statement-breakpoint
ALTER TABLE `platform_links` ADD `pulls_stale_at` integer;--> statement-breakpoint
ALTER TABLE `review_repos` ADD `pulls_indexed_at` integer;