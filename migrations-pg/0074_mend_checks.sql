ALTER TABLE "mend_jobs" ADD COLUMN "checks" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mend_jobs" ADD COLUMN "checks_head" text;--> statement-breakpoint
ALTER TABLE "mend_jobs" ADD COLUMN "check_items" text;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "mend_checks" bigint DEFAULT 0 NOT NULL;