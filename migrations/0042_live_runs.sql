CREATE TABLE `live_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`live_run_id` text NOT NULL,
	`author_id` text,
	`author_login` text NOT NULL,
	`finding_id` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`live_run_id`) REFERENCES `live_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `live_comments_run_created` ON `live_comments` (`live_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `live_comments_account_created` ON `live_comments` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_events` (
	`account_id` text NOT NULL,
	`live_run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`at` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`live_run_id`, `seq`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`live_run_id`) REFERENCES `live_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `live_events_account_run` ON `live_events` (`account_id`,`live_run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `live_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`live_run_id` text NOT NULL,
	`grantee_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`live_run_id`) REFERENCES `live_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantee_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_grants_run_grantee` ON `live_grants` (`live_run_id`,`grantee_id`);--> statement-breakpoint
CREATE INDEX `live_grants_account_run` ON `live_grants` (`account_id`,`live_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `live_grants_grantee` ON `live_grants` (`grantee_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`run_id` text NOT NULL,
	`repo_hash` text NOT NULL,
	`source` text NOT NULL,
	`pr_repository` text,
	`pr_number` integer,
	`target` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`verdict` text,
	`events` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`link_nonce` text,
	`link_role` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_runs_account_run` ON `live_runs` (`account_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `live_runs_account_updated` ON `live_runs` (`account_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `accounts_login` ON `accounts` (`login`);