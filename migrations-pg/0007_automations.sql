CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" bigint DEFAULT 1 NOT NULL,
	"trigger" text NOT NULL,
	"conditions" text NOT NULL,
	"actions" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"trigger" text NOT NULL,
	"pull" text NOT NULL,
	"event_key" text NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"actions" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rules_account_trigger" ON "automation_rules" USING btree ("account_id","trigger");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_rule_event" ON "automation_runs" USING btree ("rule_id","event_key");--> statement-breakpoint
CREATE INDEX "automation_runs_account_created" ON "automation_runs" USING btree ("account_id","created_at");