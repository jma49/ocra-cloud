CREATE TABLE "notify_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event_key" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notify_channels" ADD COLUMN "events" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_links" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "pull_flows" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "notify_sends" ADD CONSTRAINT "notify_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notify_sends_channel_event" ON "notify_sends" USING btree ("channel_id","event_key");--> statement-breakpoint
CREATE INDEX "notify_sends_account_created" ON "notify_sends" USING btree ("account_id","created_at");