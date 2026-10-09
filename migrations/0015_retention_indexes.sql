-- When a session ends, for retention's delete (audit C3). Written by hand:
-- drizzle-kit splits an expression index's columns at the comma.
CREATE INDEX `sessions_ends` ON `sessions` (coalesce(`refresh_expires_at`, `expires_at`));
