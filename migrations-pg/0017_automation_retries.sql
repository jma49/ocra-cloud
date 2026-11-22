ALTER TABLE "automation_runs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "attempts" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "retry" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "retry_at" bigint;--> statement-breakpoint
CREATE INDEX "automation_runs_retry" ON "automation_runs" USING btree ("retry_at");