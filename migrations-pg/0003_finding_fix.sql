ALTER TABLE "findings" ADD COLUMN "fix_start_line" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fix_end_line" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fix_replacement" text;