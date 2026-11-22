CREATE TABLE "review_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"thread_key" text NOT NULL,
	"starter_id" text NOT NULL,
	"starter_login" text NOT NULL,
	"started_at" bigint NOT NULL,
	"replied_at" bigint,
	"starter_replied_at" bigint,
	"seen_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_review_repo_id_review_repos_id_fk" FOREIGN KEY ("review_repo_id") REFERENCES "public"."review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_threads_thread" ON "review_threads" USING btree ("review_repo_id","thread_key");--> statement-breakpoint
CREATE INDEX "review_threads_pull" ON "review_threads" USING btree ("review_repo_id","number","starter_id");--> statement-breakpoint
CREATE INDEX "review_threads_account_seen" ON "review_threads" USING btree ("account_id","seen_at");