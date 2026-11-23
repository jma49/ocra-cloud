CREATE TABLE "stack_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"full_name" text NOT NULL,
	"path" text NOT NULL,
	"bottom" bigint NOT NULL,
	"trunk" text NOT NULL,
	"method" text NOT NULL,
	"chain" text NOT NULL,
	"step" bigint DEFAULT 0 NOT NULL,
	"current" bigint NOT NULL,
	"head" text NOT NULL,
	"updated_from" text,
	"restacked" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"started_by" text NOT NULL,
	"claimed_at" bigint,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_merges" ADD CONSTRAINT "stack_merges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stack_merges_bottom" ON "stack_merges" USING btree ("account_id","platform","host","full_name","bottom");--> statement-breakpoint
CREATE INDEX "stack_merges_current" ON "stack_merges" USING btree ("account_id","platform","host","full_name","current");--> statement-breakpoint
CREATE INDEX "stack_merges_head" ON "stack_merges" USING btree ("account_id","platform","host","full_name","head");--> statement-breakpoint
CREATE INDEX "stack_merges_account_updated" ON "stack_merges" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "stack_merges_due" ON "stack_merges" USING btree ("state","updated_at");