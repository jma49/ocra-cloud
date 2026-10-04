CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`models` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_account_id_unique` ON `preferences` (`account_id`);--> statement-breakpoint
DROP TABLE `reviews`;--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`run_id` text NOT NULL,
	`repo_hash` text NOT NULL,
	`source` text NOT NULL,
	`tier` text,
	`verdict` text,
	`complete` integer DEFAULT true NOT NULL,
	`findings` integer DEFAULT 0 NOT NULL,
	`critical` integer DEFAULT 0 NOT NULL,
	`warning` integer DEFAULT 0 NOT NULL,
	`suggestion` integer DEFAULT 0 NOT NULL,
	`files_reviewed` integer DEFAULT 0 NOT NULL,
	`files_not_reviewed` integer DEFAULT 0 NOT NULL,
	`tasks_completed` integer DEFAULT 0 NOT NULL,
	`tasks_failed` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ocra_version` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_account_run` ON `reviews` (`account_id`,`run_id`);
