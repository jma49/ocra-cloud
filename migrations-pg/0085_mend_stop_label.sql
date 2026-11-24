ALTER TABLE "mend_jobs" ADD COLUMN "stop" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mend_jobs" ADD COLUMN "labeled" bigint DEFAULT 0 NOT NULL;