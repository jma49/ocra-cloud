CREATE TABLE "scheduled_report_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"report_id" text NOT NULL,
	"period" text NOT NULL,
	"period_from" bigint NOT NULL,
	"period_to" bigint NOT NULL,
	"channels" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" bigint DEFAULT 1 NOT NULL,
	"cadence" text NOT NULL,
	"hour" bigint NOT NULL,
	"weekday" bigint,
	"month_day" bigint,
	"repo_ids" text,
	"sections" text NOT NULL,
	"channel_ids" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_report_sends" ADD CONSTRAINT "scheduled_report_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_report_sends_period" ON "scheduled_report_sends" USING btree ("report_id","period");--> statement-breakpoint
CREATE INDEX "scheduled_report_sends_account_created" ON "scheduled_report_sends" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduled_reports_account_created" ON "scheduled_reports" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduled_reports_enabled" ON "scheduled_reports" USING btree ("enabled","account_id");