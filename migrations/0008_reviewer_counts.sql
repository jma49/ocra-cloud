ALTER TABLE `reviews` ADD `by_reviewer` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `verification` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `fixed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `dismissed` integer DEFAULT 0 NOT NULL;