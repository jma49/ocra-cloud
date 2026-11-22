ALTER TABLE `automation_runs` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `retry` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `retry_at` integer;--> statement-breakpoint
CREATE INDEX `automation_runs_retry` ON `automation_runs` (`retry_at`);