ALTER TABLE "review_jobs" ADD COLUMN "depth" text;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "review_depth" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
UPDATE "review_repos" SET "review_depth" = CASE "review_profile" WHEN 'quiet' THEN 'quick' WHEN 'thorough' THEN 'deep' ELSE 'standard' END;
