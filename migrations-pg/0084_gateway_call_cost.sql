ALTER TABLE "gateway_calls" ADD COLUMN "cache_read" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "cache_write_5m" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "cache_write_1h" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "cost_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "price_version" text;