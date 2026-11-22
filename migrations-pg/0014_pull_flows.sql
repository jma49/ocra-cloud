CREATE TABLE "pull_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"draft" bigint DEFAULT 0 NOT NULL,
	"size" bigint,
	"opened_at" bigint,
	"ready_at" bigint,
	"reopened_at" bigint,
	"first_review_requested_at" bigint,
	"first_review_at" bigint,
	"first_approval_at" bigint,
	"seen_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"review_key" text NOT NULL,
	"reviewer" text NOT NULL,
	"approved" bigint NOT NULL,
	"submitted_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_flows" ADD CONSTRAINT "pull_flows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_flows" ADD CONSTRAINT "pull_flows_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_reviews" ADD CONSTRAINT "pull_reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_reviews" ADD CONSTRAINT "pull_reviews_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_flows_pull" ON "pull_flows" USING btree ("review_repo_id","number");--> statement-breakpoint
CREATE INDEX "pull_flows_account_seen" ON "pull_flows" USING btree ("account_id","seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_reviews_review" ON "pull_reviews" USING btree ("review_repo_id","review_key");--> statement-breakpoint
CREATE INDEX "pull_reviews_account_submitted" ON "pull_reviews" USING btree ("account_id","submitted_at");