CREATE TABLE "merge_check_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"head" text NOT NULL,
	"conclusion" text NOT NULL,
	"results" text NOT NULL,
	"digest" text NOT NULL,
	"posted_digest" text,
	"external_id" text,
	"posted_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"settings" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "linked_tasks" text;--> statement-breakpoint
ALTER TABLE "merge_check_runs" ADD CONSTRAINT "merge_check_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_check_runs" ADD CONSTRAINT "merge_check_runs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_checks" ADD CONSTRAINT "merge_checks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_checks" ADD CONSTRAINT "merge_checks_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_check_runs_head" ON "merge_check_runs" USING btree ("review_repo_id","number","head");--> statement-breakpoint
CREATE INDEX "merge_check_runs_account_created" ON "merge_check_runs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "merge_checks_repo" ON "merge_checks" USING btree ("review_repo_id","created_at");--> statement-breakpoint
CREATE INDEX "merge_checks_account" ON "merge_checks" USING btree ("account_id");