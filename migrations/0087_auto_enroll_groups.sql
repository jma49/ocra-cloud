CREATE TABLE `auto_enroll_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`host` text NOT NULL,
	`group_id` text NOT NULL,
	`full_path` text NOT NULL,
	`automatic` integer DEFAULT false NOT NULL,
	`last_project_id` integer DEFAULT 0 NOT NULL,
	`swept_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auto_enroll_groups_group` ON `auto_enroll_groups` (`host`,`group_id`);--> statement-breakpoint
CREATE INDEX `auto_enroll_groups_account` ON `auto_enroll_groups` (`account_id`);--> statement-breakpoint
CREATE INDEX `auto_enroll_groups_swept` ON `auto_enroll_groups` (`swept_at`);