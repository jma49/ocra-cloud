CREATE TABLE `automation_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`review_repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`logins` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_assignments_rule_pull` ON `automation_assignments` (`rule_id`,`review_repo_id`,`number`);--> statement-breakpoint
CREATE INDEX `automation_assignments_account_created` ON `automation_assignments` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_assignments_repo` ON `automation_assignments` (`review_repo_id`);--> statement-breakpoint
ALTER TABLE `automation_rules` ADD `assign_cursor` integer DEFAULT 0 NOT NULL;