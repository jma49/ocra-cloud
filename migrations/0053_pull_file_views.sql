CREATE TABLE `pull_file_views` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`path` text NOT NULL,
	`sha` text NOT NULL,
	`viewed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_file_views_file` ON `pull_file_views` (`account_id`,`platform`,`repo`,`number`,`path`);--> statement-breakpoint
CREATE INDEX `pull_file_views_account_viewed` ON `pull_file_views` (`account_id`,`viewed_at`);