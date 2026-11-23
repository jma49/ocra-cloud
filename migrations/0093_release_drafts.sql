CREATE TABLE `release_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`repo` text NOT NULL,
	`tag` text NOT NULL,
	`target` text NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_drafts_account_repo_tag` ON `release_drafts` (`account_id`,`platform`,`repo`,`tag`);--> statement-breakpoint
CREATE INDEX `release_drafts_account_updated` ON `release_drafts` (`account_id`,`updated_at`);