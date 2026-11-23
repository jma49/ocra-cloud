CREATE TABLE "auto_enroll_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"host" text NOT NULL,
	"group_id" text NOT NULL,
	"full_path" text NOT NULL,
	"automatic" bigint DEFAULT 0 NOT NULL,
	"last_project_id" bigint DEFAULT 0 NOT NULL,
	"swept_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_enroll_groups" ADD CONSTRAINT "auto_enroll_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_enroll_groups_group" ON "auto_enroll_groups" USING btree ("host","group_id");--> statement-breakpoint
CREATE INDEX "auto_enroll_groups_account" ON "auto_enroll_groups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "auto_enroll_groups_swept" ON "auto_enroll_groups" USING btree ("swept_at");