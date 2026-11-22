CREATE TABLE "finding_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"review_id" text NOT NULL,
	"number" bigint,
	"url" text,
	"claimed_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_issues" ADD CONSTRAINT "finding_issues_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_issues" ADD CONSTRAINT "finding_issues_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_issues_finding" ON "finding_issues" USING btree ("finding_id","account_id","review_id");--> statement-breakpoint
CREATE INDEX "finding_issues_account_review" ON "finding_issues" USING btree ("account_id","review_id");