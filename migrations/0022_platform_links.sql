CREATE TABLE `platform_links` (
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`account_id`, `platform`, `host`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
