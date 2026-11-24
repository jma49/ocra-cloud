ALTER TABLE "finding_threads" ADD COLUMN "comment_id" text;--> statement-breakpoint
ALTER TABLE "finding_threads" ADD COLUMN "reactions_at" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "thumbs_up" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "thumbs_down" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "reactions_read_at" bigint;--> statement-breakpoint
-- A GitHub thread is keyed by the review comment that starts it, which its reactions are read by.
UPDATE finding_threads SET comment_id = thread_key WHERE comment_id IS NULL
  AND review_repo_id IN (SELECT id FROM review_repos WHERE platform = 'github');
