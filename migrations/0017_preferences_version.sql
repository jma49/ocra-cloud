-- The version a save compares and sets (audit C6). An existing row is the
-- account's newest saved version.
ALTER TABLE `preferences` ADD `version` text;--> statement-breakpoint
UPDATE `preferences` SET `version` = (
	SELECT `id` FROM `preference_versions`
	WHERE `preference_versions`.`account_id` = `preferences`.`account_id`
	ORDER BY `created_at` DESC LIMIT 1
);
