-- Sign-in identities move out of accounts, so an account may sign in
-- through OpenID Connect as well as GitHub. The column is dropped, never the
-- table rebuilt: D1 keeps foreign keys on, so dropping accounts would
-- cascade every account's data away.
CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `identities_account` ON `identities` (`account_id`);--> statement-breakpoint
INSERT INTO `identities` (`provider`, `subject`, `account_id`, `created_at`) SELECT 'github', CAST(`github_id` AS text), `id`, `created_at` FROM `accounts`;--> statement-breakpoint
DROP INDEX `accounts_github_id_unique`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `github_id`;