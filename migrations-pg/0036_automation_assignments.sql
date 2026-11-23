CREATE TABLE "automation_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"logins" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "assign_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_assignments" ADD CONSTRAINT "automation_assignments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_assignments" ADD CONSTRAINT "automation_assignments_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_assignments_rule_pull" ON "automation_assignments" USING btree ("rule_id","review_repo_id","number");--> statement-breakpoint
CREATE INDEX "automation_assignments_account_created" ON "automation_assignments" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_assignments_repo" ON "automation_assignments" USING btree ("review_repo_id");