CREATE TABLE `budgets` (
	`account_id` text PRIMARY KEY NOT NULL,
	`daily_calls` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
