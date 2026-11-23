CREATE TABLE "auto_enroll_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"host" text NOT NULL,
	"installation_id" text NOT NULL,
	"owner" text NOT NULL,
	"automatic" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_enroll_installations" ADD CONSTRAINT "auto_enroll_installations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_enroll_installations_installation" ON "auto_enroll_installations" USING btree ("host","installation_id");--> statement-breakpoint
CREATE INDEX "auto_enroll_installations_account" ON "auto_enroll_installations" USING btree ("account_id");