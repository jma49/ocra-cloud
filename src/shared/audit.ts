// The account's audit log as the console reads it (GET /api/audit): what
// changed and when, with the few fields each kind keeps, never a key, a
// token, an address or a body.

type Pull = { pull: string };
/** Logins, which the platforms show to anyone who reaches the pull request. */
type People = { added: string[]; removed: string[] };
/** A stack merge, named by its bottom and top pull requests. */
type StackMerge = Pull & { top: number; method: string };
type MergeEnded = Pull & { mode: string; method: string; head: string; reason: string | null };

/** What each kind of event keeps, by kind. */
export type AuditDetails = {
  "session.signed_in": { client: "web" | "cli"; method: "github" | "oidc" | "device" };
  "session.signed_out": { client: "web" | "cli" };
  "session.revoked": { current: boolean };
  "device.decided": { approved: boolean };
  "token.created": { prefix: string; scopes: string[]; expiresAt: string };
  "token.revoked": { prefix: string };
  "token.first_used": { prefix: string };
  "platform.connected": { platform: string };
  "settings.changed": { keys: string[]; version: number };
  "sharing.changed": { shareFindings: boolean; deleted: number };
  "sharing.hosted_changed": { hostedFindings: boolean; deleted: number };
  "budget.changed": { dailyCalls: number | null };
  "budget.spend_changed": { dailyUsd: number | null; monthlyUsd: number | null };
  "key.saved": { provider: string; check: string };
  "key.checked": { provider: string; check: string };
  "key.deleted": { provider: string };
  "channel.added": { channel: string; kind: string };
  "channel.changed": { channel: string; keys: string[] };
  "channel.removed": { channel: string };
  /** Never confirmed, deleted by the daily retention. */
  "channel.expired": { channel: string; kind: string };
  "automation.added": { rule: string; trigger: string };
  "automation.changed": { rule: string; trigger: string; enabled: boolean };
  "automation.removed": { rule: string };
  "report.added": { report: string; cadence: string };
  "report.changed": { report: string; cadence: string; enabled: boolean };
  "report.removed": { report: string };
  "auto_review.enrolled": { repo: string; platform: string };
  "auto_review.auto_enroll_changed": { owner: string; enabled: boolean; automatic: boolean };
  "auto_review.profile_changed": { repo: string; profile: string };
  "auto_review.automatic_changed": { repo: string; automatic: boolean };
  "auto_review.learn_changed": { repo: string; learn: string };
  "auto_review.unenrolled": { repo: string };
  "auto_review.renamed": { repo: string; previous: string };
  "auto_review.paused": { repo: string; reason: string };
  "auto_review.resumed": { repo: string; reason: string };
  "auto_review.access_token_set": { repo: string; bot: string };
  "auto_review.access_token_cleared": { repo: string };
  "auto_review.webhook_added": { repo: string };
  "auto_review.webhook_removed": { repo: string; removed: boolean };
  "auto_review.webhook_secret_rotated": { repo: string };
  "auto_review.pull_paused": Pull;
  "auto_review.pull_resumed": Pull;
  "live.link_changed": { run: string; role: string | null };
  "live.person_added": { run: string; login: string; role: string };
  "live.person_removed": { run: string };
  "pull.reviewed": Pull & { verdict: string };
  "pull.merged": Pull & { method: string };
  "pull.fix_applied": Pull & { finding: string };
  "pull.reviewers_changed": Pull & People;
  "pull.assignees_changed": Pull & People;
  "pull.branch_updated": Pull & { head: string };
  "merge_when_ready.armed": Pull & {
    mode: string;
    method: string;
    head: string;
    keepOnPush: boolean;
  };
  "merge_when_ready.cancelled": Pull & Partial<MergeEnded>;
  "merge_when_ready.merged": MergeEnded;
  "merge_when_ready.closed": MergeEnded;
  "merge_when_ready.disarmed": MergeEnded;
  "merge_when_ready.failed": MergeEnded;
  "stack_merge.started": StackMerge;
  "stack_merge.cancelled": StackMerge;
  "stack_merge.merged": StackMerge;
  "stack_merge.failed": StackMerge & { reason: string | null };
  "stack.retargeted": Pull & { base: string };
};
export type AuditKind = keyof AuditDetails;

/** The fields of each kind the API answers with; a field not listed is never sent. */
export const AUDIT_FIELDS: { readonly [K in AuditKind]: readonly (keyof AuditDetails[K])[] } = {
  "session.signed_in": ["client", "method"],
  "session.signed_out": ["client"],
  "session.revoked": ["current"],
  "device.decided": ["approved"],
  "token.created": ["prefix", "scopes", "expiresAt"],
  "token.revoked": ["prefix"],
  "token.first_used": ["prefix"],
  "platform.connected": ["platform"],
  "settings.changed": ["keys", "version"],
  "sharing.changed": ["shareFindings", "deleted"],
  "sharing.hosted_changed": ["hostedFindings", "deleted"],
  "budget.changed": ["dailyCalls"],
  "budget.spend_changed": ["dailyUsd", "monthlyUsd"],
  "key.saved": ["provider", "check"],
  "key.checked": ["provider", "check"],
  "key.deleted": ["provider"],
  "channel.added": ["channel", "kind"],
  "channel.changed": ["channel", "keys"],
  "channel.removed": ["channel"],
  "channel.expired": ["channel", "kind"],
  "automation.added": ["rule", "trigger"],
  "automation.changed": ["rule", "trigger", "enabled"],
  "automation.removed": ["rule"],
  "report.added": ["report", "cadence"],
  "report.changed": ["report", "cadence", "enabled"],
  "report.removed": ["report"],
  "auto_review.enrolled": ["repo", "platform"],
  "auto_review.auto_enroll_changed": ["owner", "enabled", "automatic"],
  "auto_review.profile_changed": ["repo", "profile"],
  "auto_review.automatic_changed": ["repo", "automatic"],
  "auto_review.learn_changed": ["repo", "learn"],
  "auto_review.unenrolled": ["repo"],
  "auto_review.renamed": ["repo", "previous"],
  "auto_review.paused": ["repo", "reason"],
  "auto_review.resumed": ["repo", "reason"],
  "auto_review.access_token_set": ["repo", "bot"],
  "auto_review.access_token_cleared": ["repo"],
  "auto_review.webhook_added": ["repo"],
  "auto_review.webhook_removed": ["repo", "removed"],
  "auto_review.webhook_secret_rotated": ["repo"],
  "auto_review.pull_paused": ["pull"],
  "auto_review.pull_resumed": ["pull"],
  "live.link_changed": ["run", "role"],
  "live.person_added": ["run", "login", "role"],
  "live.person_removed": ["run"],
  "pull.reviewed": ["pull", "verdict"],
  "pull.merged": ["pull", "method"],
  "pull.fix_applied": ["pull", "finding"],
  "pull.reviewers_changed": ["pull", "added", "removed"],
  "pull.assignees_changed": ["pull", "added", "removed"],
  "pull.branch_updated": ["pull", "head"],
  "merge_when_ready.armed": ["pull", "mode", "method", "head", "keepOnPush"],
  "merge_when_ready.cancelled": ["pull", "mode", "method", "head", "reason"],
  "merge_when_ready.merged": ["pull", "mode", "method", "head", "reason"],
  "merge_when_ready.closed": ["pull", "mode", "method", "head", "reason"],
  "merge_when_ready.disarmed": ["pull", "mode", "method", "head", "reason"],
  "merge_when_ready.failed": ["pull", "mode", "method", "head", "reason"],
  "stack_merge.started": ["pull", "top", "method"],
  "stack_merge.cancelled": ["pull", "top", "method"],
  "stack_merge.merged": ["pull", "top", "method"],
  "stack_merge.failed": ["pull", "top", "method", "reason"],
  "stack.retargeted": ["pull", "base"],
};
export const AUDIT_KINDS = Object.keys(AUDIT_FIELDS) as AuditKind[];

/** One event; a field an older event did not keep is left out. */
export type AuditEventView = {
  [K in AuditKind]: { id: string; kind: K; createdAt: string; detail: Partial<AuditDetails[K]> };
}[AuditKind];

/** A page of events, newest first; `next` is the `after` of the page that follows. */
export type AuditPage = { events: AuditEventView[]; next: string | null };
