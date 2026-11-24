ALTER TABLE `mend_jobs` ADD `conflict_items` text;--> statement-breakpoint
ALTER TABLE `review_repos` ADD `mend_conflicts` integer DEFAULT false NOT NULL;