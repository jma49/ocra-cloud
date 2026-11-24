CREATE TABLE "pull_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"head" text NOT NULL,
	"pushed_at" bigint NOT NULL,
	"opened" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_versions" ADD CONSTRAINT "pull_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_versions" ADD CONSTRAINT "pull_versions_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_versions_head" ON "pull_versions" USING btree ("review_repo_id","number","head");--> statement-breakpoint
CREATE INDEX "pull_versions_pull" ON "pull_versions" USING btree ("review_repo_id","number","pushed_at");--> statement-breakpoint
CREATE INDEX "pull_versions_account_pushed" ON "pull_versions" USING btree ("account_id","pushed_at");