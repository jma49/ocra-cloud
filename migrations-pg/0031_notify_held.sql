CREATE TABLE "notify_held" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event_key" text NOT NULL,
	"event" text NOT NULL,
	"platform" text NOT NULL,
	"repo" text NOT NULL,
	"number" bigint NOT NULL,
	"line" text NOT NULL,
	"claimed_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notify_held" ADD CONSTRAINT "notify_held_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notify_held_channel_event" ON "notify_held" USING btree ("channel_id","event_key");--> statement-breakpoint
CREATE INDEX "notify_held_account_created" ON "notify_held" USING btree ("account_id","created_at");