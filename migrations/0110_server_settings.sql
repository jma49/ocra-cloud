CREATE TABLE `server_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`sealed` integer NOT NULL,
	`updated_at` integer NOT NULL
);
