CREATE TABLE `pull_seen` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`head` text,
	`unread` integer DEFAULT false NOT NULL,
	`seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_seen_account_pull` ON `pull_seen` (`account_id`,`platform`,`repo`,`number`);--> statement-breakpoint
CREATE INDEX `pull_seen_account_seen` ON `pull_seen` (`account_id`,`seen_at`);