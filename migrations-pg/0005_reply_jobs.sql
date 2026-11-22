CREATE TABLE "reply_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"comment_id" text NOT NULL,
	"inline" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reply_jobs" ADD CONSTRAINT "reply_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_jobs" ADD CONSTRAINT "reply_jobs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_jobs_comment" ON "reply_jobs" USING btree ("review_repo_id","comment_id");--> statement-breakpoint
CREATE INDEX "reply_jobs_state" ON "reply_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "reply_jobs_account_created" ON "reply_jobs" USING btree ("account_id","created_at");