CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_rules_account_trigger` ON `automation_rules` (`account_id`,`trigger`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`trigger` text NOT NULL,
	`pull` text NOT NULL,
	`event_key` text NOT NULL,
	`outcome` text DEFAULT 'running' NOT NULL,
	`actions` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_rule_event` ON `automation_runs` (`rule_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `automation_runs_account_created` ON `automation_runs` (`account_id`,`created_at`);