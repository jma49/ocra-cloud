CREATE TABLE `preference_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`changed` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
