CREATE TABLE `usage_counters` (
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`account_id`, `kind`, `day`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- The counts the caps read, from the records already stored (audit C1): the
-- shared findings by the UTC day they were uploaded, and today's uploads and
-- gateway calls.
INSERT INTO `usage_counters` (`account_id`, `kind`, `day`, `n`)
SELECT `account_id`, 'findings', strftime('%Y-%m-%d', `created_at` / 1000, 'unixepoch'), count(*)
FROM `findings` GROUP BY 1, 3;
--> statement-breakpoint
INSERT INTO `usage_counters` (`account_id`, `kind`, `day`, `n`)
SELECT `account_id`, 'uploads', date('now'), count(*)
FROM `reviews` WHERE `created_at` >= unixepoch(date('now')) * 1000 GROUP BY 1;
--> statement-breakpoint
INSERT INTO `usage_counters` (`account_id`, `kind`, `day`, `n`)
SELECT `account_id`, 'gateway_calls', date('now'), count(*)
FROM `gateway_calls` WHERE `created_at` >= unixepoch(date('now')) * 1000 GROUP BY 1;
