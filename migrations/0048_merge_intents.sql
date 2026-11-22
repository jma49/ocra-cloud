CREATE TABLE `merge_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`full_name` text NOT NULL,
	`number` integer NOT NULL,
	`method` text NOT NULL,
	`mode` text NOT NULL,
	`head` text NOT NULL,
	`keep_on_push` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`armed_by` text NOT NULL,
	`claimed_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_intents_pull` ON `merge_intents` (`account_id`,`platform`,`host`,`full_name`,`number`);--> statement-breakpoint
CREATE INDEX `merge_intents_head` ON `merge_intents` (`account_id`,`platform`,`host`,`full_name`,`head`);--> statement-breakpoint
CREATE INDEX `merge_intents_account_updated` ON `merge_intents` (`account_id`,`updated_at`);