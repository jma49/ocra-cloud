CREATE TABLE "pull_index" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"pull_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"author" text,
	"author_id" text,
	"author_avatar" text,
	"draft" bigint DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"opened_at" bigint NOT NULL,
	"changed_at" bigint NOT NULL,
	"merged_at" bigint,
	"closed_at" bigint,
	"labels" text NOT NULL,
	"additions" bigint,
	"deletions" bigint,
	"head" text,
	"head_branch" text,
	"base_branch" text,
	"reviewer_ids" text NOT NULL,
	"assignee_ids" text NOT NULL,
	"checks" text,
	"review" text,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_links" ADD COLUMN "pulls_verified_at" bigint;--> statement-breakpoint
ALTER TABLE "platform_links" ADD COLUMN "pulls_stale_at" bigint;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "pulls_indexed_at" bigint;--> statement-breakpoint
ALTER TABLE "pull_index" ADD CONSTRAINT "pull_index_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_index" ADD CONSTRAINT "pull_index_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_index_pull" ON "pull_index" USING btree ("review_repo_id","number");--> statement-breakpoint
CREATE INDEX "pull_index_account_state" ON "pull_index" USING btree ("account_id","state","changed_at");