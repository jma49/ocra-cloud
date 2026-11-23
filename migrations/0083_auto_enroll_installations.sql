CREATE TABLE `auto_enroll_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`host` text NOT NULL,
	`installation_id` text NOT NULL,
	`owner` text NOT NULL,
	`automatic` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auto_enroll_installations_installation` ON `auto_enroll_installations` (`host`,`installation_id`);--> statement-breakpoint
CREATE INDEX `auto_enroll_installations_account` ON `auto_enroll_installations` (`account_id`);