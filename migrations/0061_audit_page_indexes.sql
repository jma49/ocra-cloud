DROP INDEX `audit_events_account_created`;--> statement-breakpoint
CREATE INDEX `audit_events_account_kind_created` ON `audit_events` (`account_id`,`kind`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_account_created` ON `audit_events` (`account_id`,`created_at`,`id`);