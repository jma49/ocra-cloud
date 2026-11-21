CREATE TABLE `rate_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`start` integer NOT NULL,
	`n` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_windows_start` ON `rate_windows` (`start`);