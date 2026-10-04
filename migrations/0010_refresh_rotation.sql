ALTER TABLE `sessions` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `prev_expires_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `prev_refresh_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `rotated_at` integer;--> statement-breakpoint
CREATE INDEX `sessions_prev_token` ON `sessions` (`prev_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_prev_refresh` ON `sessions` (`prev_refresh_hash`);