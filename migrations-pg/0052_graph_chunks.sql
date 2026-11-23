-- A graph kept in graph_builds.content is not carried over: the next push, or Rebuild, builds it again.
DELETE FROM "graph_builds" WHERE "state" = 'done';--> statement-breakpoint
CREATE TABLE "graph_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"build_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"data" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_impacts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"graph_repo_id" text NOT NULL,
	"number" bigint NOT NULL,
	"head" text NOT NULL,
	"view" text NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graph_chunks" ADD CONSTRAINT "graph_chunks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_chunks" ADD CONSTRAINT "graph_chunks_build_id_graph_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."graph_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_impacts" ADD CONSTRAINT "pull_impacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_impacts" ADD CONSTRAINT "pull_impacts_graph_repo_id_graph_repos_id_fk" FOREIGN KEY ("graph_repo_id") REFERENCES "public"."graph_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_chunks_build_seq" ON "graph_chunks" USING btree ("build_id","seq");--> statement-breakpoint
CREATE INDEX "graph_chunks_account" ON "graph_chunks" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_impacts_repo_number" ON "pull_impacts" USING btree ("graph_repo_id","number");--> statement-breakpoint
CREATE INDEX "pull_impacts_account_created" ON "pull_impacts" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "graph_builds" DROP COLUMN "content";