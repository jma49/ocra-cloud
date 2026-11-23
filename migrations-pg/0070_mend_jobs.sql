CREATE TABLE "mend_items" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"job_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text,
	"reason" text,
	"commit_sha" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mend_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"again" bigint DEFAULT 0 NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"outcome" text,
	"commit_sha" text,
	"loop" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "mend" text DEFAULT 'propose' NOT NULL;--> statement-breakpoint
ALTER TABLE "mend_items" ADD CONSTRAINT "mend_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mend_items" ADD CONSTRAINT "mend_items_job_id_mend_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."mend_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mend_items" ADD CONSTRAINT "mend_items_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mend_jobs" ADD CONSTRAINT "mend_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mend_jobs" ADD CONSTRAINT "mend_jobs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mend_items_account_finding" ON "mend_items" USING btree ("account_id","finding_id");--> statement-breakpoint
CREATE INDEX "mend_items_job" ON "mend_items" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "mend_items_finding" ON "mend_items" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mend_jobs_pull" ON "mend_jobs" USING btree ("review_repo_id","number");--> statement-breakpoint
CREATE INDEX "mend_jobs_state" ON "mend_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "mend_jobs_account_repo" ON "mend_jobs" USING btree ("account_id","review_repo_id","number");