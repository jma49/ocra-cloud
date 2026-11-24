-- A finding whose comment's thread a person resolved on the platform, before
-- the webhook moved findings too, gets the thread's resolution time; then an
-- open finding with a resolved thread is addressed, as it is from now on.
UPDATE findings SET thread_resolved_at = (
  SELECT max(t.state_at) FROM finding_threads t, reviews r
  WHERE r.id = findings.review_id AND r.account_id = findings.account_id
    AND t.account_id = findings.account_id AND t.state = 'resolved'
    AND t.fingerprint = findings.fingerprint AND t.number = r.pr_number
    AND t.repository = lower(r.pr_repository)
) WHERE thread_resolved_at IS NULL AND EXISTS (
  SELECT 1 FROM finding_threads t, reviews r
  WHERE r.id = findings.review_id AND r.account_id = findings.account_id
    AND t.account_id = findings.account_id AND t.state = 'resolved'
    AND t.fingerprint = findings.fingerprint AND t.number = r.pr_number
    AND t.repository = lower(r.pr_repository)
);--> statement-breakpoint
UPDATE findings SET status = 'addressed', decided_at = thread_resolved_at
WHERE status = 'open' AND thread_resolved_at IS NOT NULL;
