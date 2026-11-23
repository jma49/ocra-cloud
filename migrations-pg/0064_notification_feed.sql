CREATE TABLE "notification_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"link" text NOT NULL,
	"repo" text,
	"number" bigint,
	"read_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_feed" ADD CONSTRAINT "notification_feed_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_feed_account_event" ON "notification_feed" USING btree ("account_id","event_key");--> statement-breakpoint
CREATE INDEX "notification_feed_account_created" ON "notification_feed" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notification_feed_account_unread" ON "notification_feed" USING btree ("account_id","read_at","created_at");