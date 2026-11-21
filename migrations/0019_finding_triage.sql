DROP INDEX `findings_account`;--> statement-breakpoint
ALTER TABLE `findings` ADD `status` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `note` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `decided_at` integer;--> statement-breakpoint
CREATE INDEX `findings_account_status_created` ON `findings` (`account_id`,`status`,`created_at`,`id`);