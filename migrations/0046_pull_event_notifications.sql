CREATE TABLE `notify_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`event_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_sends_channel_event` ON `notify_sends` (`channel_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `notify_sends_account_created` ON `notify_sends` (`account_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `events` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_links` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `pull_flows` ADD `author_id` text;