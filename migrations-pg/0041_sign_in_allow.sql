ALTER TABLE "accounts" ADD COLUMN "sign_in_allow_key" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "sign_in_allowed" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "sign_in_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "sign_in_tried_at" bigint;