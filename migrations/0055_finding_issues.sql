CREATE TABLE `finding_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`review_id` text NOT NULL,
	`number` integer,
	`url` text,
	`claimed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_issues_finding` ON `finding_issues` (`finding_id`,`account_id`,`review_id`);--> statement-breakpoint
CREATE INDEX `finding_issues_account_review` ON `finding_issues` (`account_id`,`review_id`);