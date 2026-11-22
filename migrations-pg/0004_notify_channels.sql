CREATE TABLE "notify_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"when" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"last_status" text,
	"last_sent_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notify_channels" ADD CONSTRAINT "notify_channels_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notify_channels_account" ON "notify_channels" USING btree ("account_id");