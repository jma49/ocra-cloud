CREATE TABLE "account_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"repo_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	"file" text,
	"title" text,
	"reason" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"share_findings" bigint DEFAULT 0 NOT NULL,
	"salt" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"account_id" text PRIMARY KEY NOT NULL,
	"daily_calls" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_account_id" text,
	"interval_seconds" bigint DEFAULT 5 NOT NULL,
	"last_polled_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"review_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"reviewer" text NOT NULL,
	"severity" text NOT NULL,
	"category" text,
	"verification" text,
	"file" text NOT NULL,
	"line_start" bigint,
	"line_end" bigint,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"suggestion" text,
	"code" text,
	"redacted" bigint DEFAULT 0 NOT NULL,
	"truncated" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"note" text,
	"decided_at" bigint,
	"position" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"path" text NOT NULL,
	"model" text,
	"status" bigint NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"graph_repo_id" text NOT NULL,
	"commit" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"lease_until" bigint,
	"error" text,
	"content" "bytea",
	"bytes" bigint,
	"files" bigint,
	"parsed" bigint,
	"reused" bigint,
	"skipped" bigint,
	"truncated" bigint DEFAULT 0 NOT NULL,
	"finished_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"platform_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"branch" text NOT NULL,
	"webhook_secret_hash" text,
	"consented_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "platform_links" (
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"access_expires_at" bigint,
	"refresh_expires_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "platform_links_account_id_platform_host_pk" PRIMARY KEY("account_id","platform","host")
);
--> statement-breakpoint
CREATE TABLE "preference_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"snapshot" text NOT NULL,
	"changed" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"account_id" text PRIMARY KEY NOT NULL,
	"models" text,
	"runtime" text,
	"agents" text,
	"settings" text,
	"version" text,
	"updated_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"check_status" text,
	"checked_at" bigint,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_views" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"filters" text NOT NULL,
	"position" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_windows" (
	"key" text PRIMARY KEY NOT NULL,
	"start" bigint NOT NULL,
	"n" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"repo_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"run_id" text NOT NULL,
	"repo_hash" text NOT NULL,
	"source" text NOT NULL,
	"tier" text,
	"verdict" text,
	"complete" bigint DEFAULT 1 NOT NULL,
	"findings" bigint DEFAULT 0 NOT NULL,
	"critical" bigint DEFAULT 0 NOT NULL,
	"warning" bigint DEFAULT 0 NOT NULL,
	"suggestion" bigint DEFAULT 0 NOT NULL,
	"files_reviewed" bigint DEFAULT 0 NOT NULL,
	"files_not_reviewed" bigint DEFAULT 0 NOT NULL,
	"tasks_completed" bigint DEFAULT 0 NOT NULL,
	"tasks_failed" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"ocra_version" text,
	"by_reviewer" text,
	"verification" text,
	"fixed" bigint DEFAULT 0 NOT NULL,
	"dismissed" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_counters" (
	"name" text NOT NULL,
	"day" text NOT NULL,
	"n" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "service_counters_day_name_pk" PRIMARY KEY("day","name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	"refresh_hash" text,
	"refresh_expires_at" bigint,
	"last_used_at" bigint,
	"prev_token_hash" text,
	"prev_expires_at" bigint,
	"prev_refresh_hash" text,
	"rotated_at" bigint,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"day" text NOT NULL,
	"n" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "usage_counters_account_id_kind_day_pk" PRIMARY KEY("account_id","kind","day")
);
--> statement-breakpoint
ALTER TABLE "account_memory" ADD CONSTRAINT "account_memory_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_approved_account_id_accounts_id_fk" FOREIGN KEY ("approved_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD CONSTRAINT "gateway_calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_builds" ADD CONSTRAINT "graph_builds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_builds" ADD CONSTRAINT "graph_builds_graph_repo_id_graph_repos_id_fk" FOREIGN KEY ("graph_repo_id") REFERENCES "public"."graph_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_repos" ADD CONSTRAINT "graph_repos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_links" ADD CONSTRAINT "platform_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_versions" ADD CONSTRAINT "preference_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_views" ADD CONSTRAINT "pull_views_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_memory_account_created" ON "account_memory" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "account_memory_repo_created" ON "account_memory" USING btree ("account_id","repo_hash","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_account_created" ON "audit_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "findings_review" ON "findings" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "findings_account_status_created" ON "findings" USING btree ("account_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "gateway_calls_account_created" ON "gateway_calls" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_builds_repo_commit" ON "graph_builds" USING btree ("graph_repo_id","commit");--> statement-breakpoint
CREATE INDEX "graph_builds_state" ON "graph_builds" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "graph_builds_account_created" ON "graph_builds" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_repos_account_repo" ON "graph_repos" USING btree ("account_id","platform","host","platform_repo_id");--> statement-breakpoint
CREATE INDEX "graph_repos_platform_repo" ON "graph_repos" USING btree ("platform","host","platform_repo_id");--> statement-breakpoint
CREATE INDEX "identities_account" ON "identities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "preference_versions_account_created" ON "preference_versions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_account_provider" ON "provider_keys" USING btree ("account_id","provider");--> statement-breakpoint
CREATE INDEX "pull_views_account_position" ON "pull_views" USING btree ("account_id","position");--> statement-breakpoint
CREATE INDEX "rate_windows_start" ON "rate_windows" USING btree ("start");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_account_repo" ON "repositories" USING btree ("account_id","repo_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_account_run" ON "reviews" USING btree ("account_id","run_id");--> statement-breakpoint
CREATE INDEX "reviews_account_created" ON "reviews" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_prev_token" ON "sessions" USING btree ("prev_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_prev_refresh" ON "sessions" USING btree ("prev_refresh_hash");--> statement-breakpoint
CREATE INDEX "sessions_account" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_ends" ON "sessions" USING btree (coalesce("refresh_expires_at", "expires_at"));