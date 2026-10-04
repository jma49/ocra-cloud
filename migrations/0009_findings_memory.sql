CREATE TABLE `account_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`repo_hash` text NOT NULL,
	`fingerprint` text NOT NULL,
	`file` text,
	`title` text,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`review_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`reviewer` text NOT NULL,
	`severity` text NOT NULL,
	`category` text,
	`verification` text,
	`file` text NOT NULL,
	`line_start` integer,
	`line_end` integer,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`suggestion` text,
	`code` text,
	`redacted` integer DEFAULT false NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `share_findings` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `salt` text;