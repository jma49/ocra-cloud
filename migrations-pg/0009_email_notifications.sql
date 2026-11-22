ALTER TABLE "accounts" ADD COLUMN "digest_day" text;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "confirmed_at" bigint;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "confirm_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "digest" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "notify_channels" SET "confirmed_at" = "created_at";