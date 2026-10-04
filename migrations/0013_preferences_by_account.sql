-- preferences: one row per account, keyed by it (#34). No table references
-- preferences, so it is rebuilt without turning foreign keys off, which D1
-- does not allow.
CREATE TABLE `__new_preferences` (
	`account_id` text PRIMARY KEY NOT NULL,
	`models` text,
	`runtime` text,
	`agents` text,
	`settings` text,
	`updated_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_preferences`("account_id", "models", "runtime", "agents", "settings", "updated_at", "created_at") SELECT "account_id", "models", "runtime", "agents", "settings", "updated_at", "created_at" FROM `preferences`;--> statement-breakpoint
DROP TABLE `preferences`;--> statement-breakpoint
ALTER TABLE `__new_preferences` RENAME TO `preferences`;