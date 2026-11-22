CREATE TABLE `notify_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`when` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`last4` text NOT NULL,
	`last_status` text,
	`last_sent_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notify_channels_account` ON `notify_channels` (`account_id`);