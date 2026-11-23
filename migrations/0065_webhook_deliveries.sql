CREATE TABLE `webhook_deliveries` (
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
CREATE INDEX `webhook_deliveries_channel_created` ON `webhook_deliveries` (`account_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_account_created` ON `webhook_deliveries` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_retry` ON `webhook_deliveries` (`retry_at`);