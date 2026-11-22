ALTER TABLE "reviews" ADD COLUMN "pr_repository" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pr_number" bigint;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pr_head_sha" text;