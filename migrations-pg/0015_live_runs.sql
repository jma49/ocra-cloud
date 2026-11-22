CREATE TABLE "live_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"live_run_id" text NOT NULL,
	"author_id" text,
	"author_login" text NOT NULL,
	"finding_id" text,
	"body" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_events" (
	"account_id" text NOT NULL,
	"live_run_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"data" text NOT NULL,
	"at" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "live_events_live_run_id_seq_pk" PRIMARY KEY("live_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "live_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"live_run_id" text NOT NULL,
	"grantee_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"run_id" text NOT NULL,
	"repo_hash" text NOT NULL,
	"source" text NOT NULL,
	"pr_repository" text,
	"pr_number" bigint,
	"target" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"verdict" text,
	"events" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"link_nonce" text,
	"link_role" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_comments" ADD CONSTRAINT "live_comments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_comments" ADD CONSTRAINT "live_comments_live_run_id_live_runs_id_fk" FOREIGN KEY ("live_run_id") REFERENCES "public"."live_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_comments" ADD CONSTRAINT "live_comments_author_id_accounts_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_events" ADD CONSTRAINT "live_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_events" ADD CONSTRAINT "live_events_live_run_id_live_runs_id_fk" FOREIGN KEY ("live_run_id") REFERENCES "public"."live_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_grants" ADD CONSTRAINT "live_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_grants" ADD CONSTRAINT "live_grants_live_run_id_live_runs_id_fk" FOREIGN KEY ("live_run_id") REFERENCES "public"."live_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_grants" ADD CONSTRAINT "live_grants_grantee_id_accounts_id_fk" FOREIGN KEY ("grantee_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_runs" ADD CONSTRAINT "live_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_comments_run_created" ON "live_comments" USING btree ("live_run_id","created_at");--> statement-breakpoint
CREATE INDEX "live_comments_account_created" ON "live_comments" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "live_events_account_run" ON "live_events" USING btree ("account_id","live_run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "live_grants_run_grantee" ON "live_grants" USING btree ("live_run_id","grantee_id");--> statement-breakpoint
CREATE INDEX "live_grants_account_run" ON "live_grants" USING btree ("account_id","live_run_id","created_at");--> statement-breakpoint
CREATE INDEX "live_grants_grantee" ON "live_grants" USING btree ("grantee_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "live_runs_account_run" ON "live_runs" USING btree ("account_id","run_id");--> statement-breakpoint
CREATE INDEX "live_runs_account_updated" ON "live_runs" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "accounts_login" ON "accounts" USING btree ("login");