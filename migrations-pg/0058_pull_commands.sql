CREATE TABLE "paused_pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"comment_id" text NOT NULL,
	"command" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paused_pulls" ADD CONSTRAINT "paused_pulls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paused_pulls" ADD CONSTRAINT "paused_pulls_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_commands" ADD CONSTRAINT "pull_commands_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_commands" ADD CONSTRAINT "pull_commands_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paused_pulls_pull" ON "paused_pulls" USING btree ("review_repo_id","number");--> statement-breakpoint
CREATE INDEX "paused_pulls_account" ON "paused_pulls" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_commands_comment" ON "pull_commands" USING btree ("review_repo_id","comment_id");--> statement-breakpoint
CREATE INDEX "pull_commands_account_created" ON "pull_commands" USING btree ("account_id","created_at");