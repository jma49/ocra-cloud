CREATE TABLE "review_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_chat_messages" ADD CONSTRAINT "review_chat_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_chat_messages" ADD CONSTRAINT "review_chat_messages_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_chat_messages_review" ON "review_chat_messages" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "review_chat_messages_account_review" ON "review_chat_messages" USING btree ("account_id","review_id","created_at");