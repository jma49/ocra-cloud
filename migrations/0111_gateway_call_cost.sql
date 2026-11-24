ALTER TABLE `gateway_calls` ADD `cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `cache_write_5m` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `cache_write_1h` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `cost_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `price_version` text;