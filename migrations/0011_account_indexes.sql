CREATE INDEX `account_memory_account` ON `account_memory` (`account_id`);--> statement-breakpoint
CREATE INDEX `audit_events_account_created` ON `audit_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `findings_account` ON `findings` (`account_id`);--> statement-breakpoint
CREATE INDEX `findings_review` ON `findings` (`review_id`);--> statement-breakpoint
CREATE INDEX `gateway_calls_account_created` ON `gateway_calls` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `preference_versions_account_created` ON `preference_versions` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_keys_account` ON `provider_keys` (`account_id`);--> statement-breakpoint
CREATE INDEX `reviews_account_created` ON `reviews` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_account` ON `sessions` (`account_id`);