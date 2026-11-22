CREATE TABLE "review_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"review_repo_id" text,
	"first_review_hours" bigint,
	"merge_days" bigint,
	"updated_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_targets" ADD CONSTRAINT "review_targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_targets" ADD CONSTRAINT "review_targets_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_targets_account_scope" ON "review_targets" USING btree ("account_id","scope");--> statement-breakpoint
CREATE INDEX "review_targets_repo" ON "review_targets" USING btree ("review_repo_id");