CREATE TABLE "stack_merge_layers" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"full_name" text NOT NULL,
	"number" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_merge_layers" ADD CONSTRAINT "stack_merge_layers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_merge_layers" ADD CONSTRAINT "stack_merge_layers_merge_id_stack_merges_id_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."stack_merges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stack_merge_layers_pull" ON "stack_merge_layers" USING btree ("account_id","platform","host","full_name","number");--> statement-breakpoint
CREATE INDEX "stack_merge_layers_merge" ON "stack_merge_layers" USING btree ("merge_id");