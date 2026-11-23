CREATE TABLE "restack_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"parent_merge" text NOT NULL,
	"parent" bigint NOT NULL,
	"branch" text NOT NULL,
	"head" text NOT NULL,
	"onto_branch" text NOT NULL,
	"onto_commit" text,
	"upstream" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"restacked_to" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "restack" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "restack_jobs" ADD CONSTRAINT "restack_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restack_jobs" ADD CONSTRAINT "restack_jobs_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restack_jobs_pull_merge" ON "restack_jobs" USING btree ("review_repo_id","number","parent_merge");--> statement-breakpoint
CREATE INDEX "restack_jobs_state" ON "restack_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "restack_jobs_account_repo" ON "restack_jobs" USING btree ("account_id","review_repo_id","created_at");