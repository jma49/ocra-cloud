CREATE TABLE `pull_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`draft` integer DEFAULT false NOT NULL,
	`size` integer,
	`opened_at` integer,
	`ready_at` integer,
	`reopened_at` integer,
	`first_review_requested_at` integer,
	`first_review_at` integer,
	`first_approval_at` integer,
	`seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_flows_pull` ON `pull_flows` (`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `pull_flows_account_seen` ON `pull_flows` (`account_id`,`seen_at`);--> statement-breakpoint
CREATE TABLE `pull_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`review_key` text NOT NULL,
	`reviewer` text NOT NULL,
	`approved` integer NOT NULL,
	`submitted_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_reviews_review` ON `pull_reviews` (`review_repo_id`,`review_key`);--> statement-breakpoint
CREATE INDEX `pull_reviews_account_submitted` ON `pull_reviews` (`account_id`,`submitted_at`);