CREATE TABLE `service_counters` (
	`name` text NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`name`, `day`)
);
