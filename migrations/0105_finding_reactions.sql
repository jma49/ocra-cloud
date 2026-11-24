ALTER TABLE `finding_threads` ADD `comment_id` text;--> statement-breakpoint
ALTER TABLE `finding_threads` ADD `reactions_at` integer;--> statement-breakpoint
ALTER TABLE `findings` ADD `thumbs_up` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `thumbs_down` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `reactions_read_at` integer;--> statement-breakpoint
-- A GitHub thread is keyed by the review comment that starts it, which its reactions are read by.
UPDATE finding_threads SET comment_id = thread_key WHERE comment_id IS NULL
  AND review_repo_id IN (SELECT id FROM review_repos WHERE platform = 'github');
