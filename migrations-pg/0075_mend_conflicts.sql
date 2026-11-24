ALTER TABLE "mend_jobs" ADD COLUMN "conflict_items" text;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "mend_conflicts" bigint DEFAULT 0 NOT NULL;