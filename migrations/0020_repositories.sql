CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`repo_hash` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_account_repo` ON `repositories` (`account_id`,`repo_hash`);