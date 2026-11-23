CREATE TABLE `stack_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`full_name` text NOT NULL,
	`path` text NOT NULL,
	`bottom` integer NOT NULL,
	`trunk` text NOT NULL,
	`method` text NOT NULL,
	`chain` text NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`current` integer NOT NULL,
	`head` text NOT NULL,
	`updated_from` text,
	`restacked` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`started_by` text NOT NULL,
	`claimed_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_merges_bottom` ON `stack_merges` (`account_id`,`platform`,`host`,`full_name`,`bottom`);--> statement-breakpoint
CREATE INDEX `stack_merges_current` ON `stack_merges` (`account_id`,`platform`,`host`,`full_name`,`current`);--> statement-breakpoint
CREATE INDEX `stack_merges_head` ON `stack_merges` (`account_id`,`platform`,`host`,`full_name`,`head`);--> statement-breakpoint
CREATE INDEX `stack_merges_account_updated` ON `stack_merges` (`account_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `stack_merges_due` ON `stack_merges` (`state`,`updated_at`);