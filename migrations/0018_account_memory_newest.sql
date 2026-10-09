DROP INDEX `account_memory_account`;--> statement-breakpoint
CREATE INDEX `account_memory_account_created` ON `account_memory` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `account_memory_repo_created` ON `account_memory` (`account_id`,`repo_hash`,`created_at`);