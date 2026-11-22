CREATE TABLE "pull_file_views" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"repo" text NOT NULL,
	"number" bigint NOT NULL,
	"path" text NOT NULL,
	"sha" text NOT NULL,
	"viewed_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_file_views" ADD CONSTRAINT "pull_file_views_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_file_views_file" ON "pull_file_views" USING btree ("account_id","platform","repo","number","path");--> statement-breakpoint
CREATE INDEX "pull_file_views_account_viewed" ON "pull_file_views" USING btree ("account_id","viewed_at");