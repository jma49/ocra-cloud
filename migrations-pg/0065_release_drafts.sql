CREATE TABLE "release_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"repo" text NOT NULL,
	"tag" text NOT NULL,
	"target" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_drafts" ADD CONSTRAINT "release_drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_drafts_account_repo_tag" ON "release_drafts" USING btree ("account_id","platform","repo","tag");--> statement-breakpoint
CREATE INDEX "release_drafts_account_updated" ON "release_drafts" USING btree ("account_id","updated_at");