CREATE TABLE "inbound_events" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"repo" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 1 NOT NULL,
	"work" text,
	"retry_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_delivery" ON "inbound_events" USING btree ("platform","host","delivery_id");--> statement-breakpoint
CREATE INDEX "inbound_events_retry" ON "inbound_events" USING btree ("retry_at");--> statement-breakpoint
CREATE INDEX "inbound_events_created" ON "inbound_events" USING btree ("created_at");