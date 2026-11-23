CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"status" bigint,
	"error" text,
	"latency_ms" bigint,
	"payload" text,
	"retry_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_channel_created" ON "webhook_deliveries" USING btree ("account_id","channel_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_account_created" ON "webhook_deliveries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_retry" ON "webhook_deliveries" USING btree ("retry_at");