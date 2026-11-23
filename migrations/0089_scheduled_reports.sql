CREATE TABLE `scheduled_report_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`report_id` text NOT NULL,
	`period` text NOT NULL,
	`period_from` integer NOT NULL,
	`period_to` integer NOT NULL,
	`channels` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_report_sends_period` ON `scheduled_report_sends` (`report_id`,`period`);--> statement-breakpoint
CREATE INDEX `scheduled_report_sends_account_created` ON `scheduled_report_sends` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `scheduled_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cadence` text NOT NULL,
	`hour` integer NOT NULL,
	`weekday` integer,
	`month_day` integer,
	`repo_ids` text,
	`sections` text NOT NULL,
	`channel_ids` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_reports_account_created` ON `scheduled_reports` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scheduled_reports_enabled` ON `scheduled_reports` (`enabled`,`account_id`);