CREATE TABLE "review_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"name" text NOT NULL,
	"members" text,
	"fetched_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_teams" ADD CONSTRAINT "review_teams_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_teams_team" ON "review_teams" USING btree ("account_id","platform","host","reviewer_id");--> statement-breakpoint
CREATE INDEX "review_teams_account_fetched" ON "review_teams" USING btree ("account_id","fetched_at");