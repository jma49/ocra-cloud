ALTER TABLE `gateway_calls` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `origin` text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `gateway_calls` ADD `review_id` text;