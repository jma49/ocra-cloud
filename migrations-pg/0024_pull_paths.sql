CREATE TABLE "pull_paths" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"head" text NOT NULL,
	"prefix" text NOT NULL,
	"seen_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_paths" ADD CONSTRAINT "pull_paths_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_paths" ADD CONSTRAINT "pull_paths_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_paths_prefix" ON "pull_paths" USING btree ("review_repo_id","number","prefix");--> statement-breakpoint
CREATE INDEX "pull_paths_account_seen" ON "pull_paths" USING btree ("account_id","seen_at");