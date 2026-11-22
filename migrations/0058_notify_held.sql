CREATE TABLE `notify_held` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`event_key` text NOT NULL,
	`event` text NOT NULL,
	`platform` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`line` text NOT NULL,
	`claimed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_held_channel_event` ON `notify_held` (`channel_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `notify_held_account_created` ON `notify_held` (`account_id`,`created_at`);