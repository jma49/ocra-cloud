CREATE TABLE "finding_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"repository" text NOT NULL,
	"number" bigint NOT NULL,
	"thread_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"starter_id" text NOT NULL,
	"state" text,
	"state_by" text,
	"state_at" bigint,
	"reason" text,
	"reason_by" text,
	"reason_at" bigint,
	"reason_redacted" bigint DEFAULT 0 NOT NULL,
	"reason_truncated" bigint DEFAULT 0 NOT NULL,
	"seen_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_threads" ADD CONSTRAINT "finding_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_threads" ADD CONSTRAINT "finding_threads_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_threads_thread" ON "finding_threads" USING btree ("review_repo_id","thread_key");--> statement-breakpoint
CREATE INDEX "finding_threads_pull" ON "finding_threads" USING btree ("account_id","repository","number");--> statement-breakpoint
CREATE INDEX "finding_threads_account_seen" ON "finding_threads" USING btree ("account_id","seen_at");