ALTER TABLE `webhook_deliveries` RENAME TO `notify_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notify_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`event` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` integer,
	`error` text,
	`latency_ms` integer,
	`payload` text,
	`retry_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_notify_deliveries`("id", "account_id", "channel_id", "event", "state", "attempts", "status", "error", "latency_ms", "payload", "retry_at", "created_at") SELECT "id", "account_id", "channel_id", "event", "state", "attempts", "status", "error", "latency_ms", "payload", "retry_at", "created_at" FROM `notify_deliveries`;--> statement-breakpoint
DROP TABLE `notify_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notify_deliveries` RENAME TO `notify_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notify_deliveries_channel_created` ON `notify_deliveries` (`account_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notify_deliveries_account_created` ON `notify_deliveries` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notify_deliveries_retry` ON `notify_deliveries` (`retry_at`);