ALTER TABLE `pull_views` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Two views of one account may share a name from before this index: each later one keeps its name with its id's start added.
UPDATE `pull_views` SET `name` = substr(`name`, 1, 49) || ' (' || substr(`id`, 1, 8) || ')' WHERE EXISTS (SELECT 1 FROM `pull_views` o WHERE o.`account_id` = `pull_views`.`account_id` AND o.`name` = `pull_views`.`name` AND (o.`created_at` < `pull_views`.`created_at` OR (o.`created_at` = `pull_views`.`created_at` AND o.`id` < `pull_views`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `pull_views_account_name` ON `pull_views` (`account_id`,`name`);--> statement-breakpoint
CREATE INDEX `reviews_account_pull` ON `reviews` (`account_id`,`pr_number`,`created_at`);