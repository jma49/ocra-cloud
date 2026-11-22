CREATE TABLE "closed_pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"title" text NOT NULL,
	"merged" bigint NOT NULL,
	"opened_at" bigint,
	"closed_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "report_weekday" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "report_hour" bigint DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "report_sent_for" bigint;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "weekly" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_pulls" ADD CONSTRAINT "closed_pulls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closed_pulls" ADD CONSTRAINT "closed_pulls_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "closed_pulls_pull" ON "closed_pulls" USING btree ("review_repo_id","number");--> statement-breakpoint
CREATE INDEX "closed_pulls_account_closed" ON "closed_pulls" USING btree ("account_id","closed_at");