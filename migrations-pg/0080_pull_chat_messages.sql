CREATE TABLE "pull_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"repo" text NOT NULL,
	"number" bigint NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"finding_id" text,
	"file" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_chat_messages" ADD CONSTRAINT "pull_chat_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pull_chat_messages_account_pull" ON "pull_chat_messages" USING btree ("account_id","platform","repo","number","created_at");--> statement-breakpoint
CREATE INDEX "pull_chat_messages_account_created" ON "pull_chat_messages" USING btree ("account_id","created_at");