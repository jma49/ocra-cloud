-- A rename, not a rebuild: no table references webhook_deliveries, and its own
-- foreign key to accounts is kept as it is, so no row is copied or dropped.
ALTER TABLE `webhook_deliveries` RENAME TO `notify_deliveries`;--> statement-breakpoint
DROP INDEX `webhook_deliveries_channel_created`;--> statement-breakpoint
DROP INDEX `webhook_deliveries_account_created`;--> statement-breakpoint
DROP INDEX `webhook_deliveries_retry`;--> statement-breakpoint
CREATE INDEX `notify_deliveries_channel_created` ON `notify_deliveries` (`account_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notify_deliveries_account_created` ON `notify_deliveries` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notify_deliveries_retry` ON `notify_deliveries` (`retry_at`);
