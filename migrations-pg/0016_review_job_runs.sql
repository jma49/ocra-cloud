DROP INDEX "review_jobs_pull_head";--> statement-breakpoint
ALTER TABLE "review_jobs" ADD COLUMN "run" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "review_jobs_pull_head_run" ON "review_jobs" USING btree ("review_repo_id","number","head","run");