CREATE TABLE "review_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"reviewer_id" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"done_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "reminder_hours" bigint;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "quiet_start" bigint;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "quiet_end" bigint;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_pull_reviewer" ON "review_requests" USING btree ("review_repo_id","number","reviewer_id");--> statement-breakpoint
CREATE INDEX "review_requests_account_requested" ON "review_requests" USING btree ("account_id","requested_at");