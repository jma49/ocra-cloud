CREATE TABLE "fix_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"finding_id" text NOT NULL,
	"head" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"reason" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "low_confidence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "fix_jobs" ADD CONSTRAINT "fix_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_jobs" ADD CONSTRAINT "fix_jobs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_jobs" ADD CONSTRAINT "fix_jobs_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fix_jobs_account_finding_head" ON "fix_jobs" USING btree ("account_id","finding_id","head");--> statement-breakpoint
CREATE INDEX "fix_jobs_state" ON "fix_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "fix_jobs_account_pull" ON "fix_jobs" USING btree ("account_id","review_repo_id","number");--> statement-breakpoint
CREATE INDEX "fix_jobs_finding" ON "fix_jobs" USING btree ("finding_id");