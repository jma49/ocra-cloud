CREATE TABLE `pull_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`finding_id` text,
	`file` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_chat_messages_account_pull` ON `pull_chat_messages` (`account_id`,`platform`,`repo`,`number`,`created_at`);--> statement-breakpoint
CREATE INDEX `pull_chat_messages_account_created` ON `pull_chat_messages` (`account_id`,`created_at`);