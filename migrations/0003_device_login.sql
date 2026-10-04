CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_account_id` text,
	`interval_seconds` integer DEFAULT 5 NOT NULL,
	`last_polled_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`approved_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_hash_unique` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `refresh_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `refresh_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_refresh_hash_unique` ON `sessions` (`refresh_hash`);