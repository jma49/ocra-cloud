CREATE TABLE `review_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`name` text NOT NULL,
	`members` text,
	`fetched_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_teams_team` ON `review_teams` (`account_id`,`platform`,`host`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `review_teams_account_fetched` ON `review_teams` (`account_id`,`fetched_at`);