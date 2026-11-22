CREATE TABLE "pull_seen" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"repo" text NOT NULL,
	"number" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"head" text,
	"unread" bigint DEFAULT 0 NOT NULL,
	"seen_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_seen" ADD CONSTRAINT "pull_seen_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_seen_account_pull" ON "pull_seen" USING btree ("account_id","platform","repo","number");--> statement-breakpoint
CREATE INDEX "pull_seen_account_seen" ON "pull_seen" USING btree ("account_id","seen_at");