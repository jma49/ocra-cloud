ALTER TABLE "gateway_calls" ADD COLUMN "cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "origin" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD COLUMN "review_id" text;