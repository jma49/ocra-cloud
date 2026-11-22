CREATE TABLE "review_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"head" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"review_id" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"platform_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"webhook_secret_hash" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_repos" ADD CONSTRAINT "review_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_jobs_pull_head" ON "review_jobs" USING btree ("review_repo_id","number","head");--> statement-breakpoint
CREATE INDEX "review_jobs_state" ON "review_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "review_jobs_account_created" ON "review_jobs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_repos_platform_repo" ON "review_repos" USING btree ("platform","host","platform_repo_id");--> statement-breakpoint
CREATE INDEX "review_repos_account" ON "review_repos" USING btree ("account_id");