DROP INDEX `review_jobs_pull_head`;--> statement-breakpoint
ALTER TABLE `review_jobs` ADD `run` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `review_jobs_pull_head_run` ON `review_jobs` (`review_repo_id`,`number`,`head`,`run`);