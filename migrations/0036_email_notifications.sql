ALTER TABLE `accounts` ADD `digest_day` text;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `confirm_token_hash` text;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `confirm_expires_at` integer;--> statement-breakpoint
ALTER TABLE `notify_channels` ADD `digest` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `notify_channels` SET `confirmed_at` = `created_at`;