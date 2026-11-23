CREATE TABLE `stack_merge_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`merge_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`full_name` text NOT NULL,
	`number` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merge_id`) REFERENCES `stack_merges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_merge_layers_pull` ON `stack_merge_layers` (`account_id`,`platform`,`host`,`full_name`,`number`);--> statement-breakpoint
CREATE INDEX `stack_merge_layers_merge` ON `stack_merge_layers` (`merge_id`);