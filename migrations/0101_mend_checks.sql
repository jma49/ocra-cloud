ALTER TABLE `mend_jobs` ADD `checks` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mend_jobs` ADD `checks_head` text;--> statement-breakpoint
ALTER TABLE `mend_jobs` ADD `check_items` text;--> statement-breakpoint
ALTER TABLE `review_repos` ADD `mend_checks` integer DEFAULT false NOT NULL;