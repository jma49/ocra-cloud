CREATE TABLE "merge_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"full_name" text NOT NULL,
	"number" bigint NOT NULL,
	"method" text NOT NULL,
	"mode" text NOT NULL,
	"head" text NOT NULL,
	"keep_on_push" bigint DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"armed_by" text NOT NULL,
	"claimed_at" bigint,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merge_intents" ADD CONSTRAINT "merge_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_intents_pull" ON "merge_intents" USING btree ("account_id","platform","host","full_name","number");--> statement-breakpoint
CREATE INDEX "merge_intents_head" ON "merge_intents" USING btree ("account_id","platform","host","full_name","head");--> statement-breakpoint
CREATE INDEX "merge_intents_account_updated" ON "merge_intents" USING btree ("account_id","updated_at");