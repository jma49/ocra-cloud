CREATE TABLE "review_walkthroughs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_id" text NOT NULL,
	"overview" text NOT NULL,
	"groups" text NOT NULL,
	"diagram" text,
	"redacted" bigint DEFAULT 0 NOT NULL,
	"truncated" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_walkthroughs" ADD CONSTRAINT "review_walkthroughs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_walkthroughs" ADD CONSTRAINT "review_walkthroughs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_walkthroughs_review" ON "review_walkthroughs" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "review_walkthroughs_account_created" ON "review_walkthroughs" USING btree ("account_id","created_at");