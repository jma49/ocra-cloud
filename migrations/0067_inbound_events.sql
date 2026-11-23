CREATE TABLE `inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`host` text NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`repo` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`work` text,
	`retry_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_events_delivery` ON `inbound_events` (`platform`,`host`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `inbound_events_retry` ON `inbound_events` (`retry_at`);--> statement-breakpoint
CREATE INDEX `inbound_events_created` ON `inbound_events` (`created_at`);