-- Keeps the newest key of each (account, provider) before the index makes them unique.
DELETE FROM `provider_keys` WHERE `rowid` NOT IN (
  SELECT `rowid` FROM `provider_keys` AS `p`
  WHERE `p`.`rowid` = (
    SELECT `q`.`rowid` FROM `provider_keys` AS `q`
    WHERE `q`.`account_id` = `p`.`account_id` AND `q`.`provider` = `p`.`provider`
    ORDER BY `q`.`created_at` DESC, `q`.`rowid` DESC LIMIT 1
  )
);--> statement-breakpoint
DROP INDEX `provider_keys_account`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_keys_account_provider` ON `provider_keys` (`account_id`,`provider`);
