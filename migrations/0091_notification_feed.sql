CREATE TABLE `notification_feed` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`event_key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`link` text NOT NULL,
	`repo` text,
	`number` integer,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_feed_account_event` ON `notification_feed` (`account_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `notification_feed_account_created` ON `notification_feed` (`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `notification_feed_account_unread` ON `notification_feed` (`account_id`,`read_at`,`created_at`);