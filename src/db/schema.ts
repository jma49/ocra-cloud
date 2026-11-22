import {
  GENERATE_KINDS,
  GRAPH_BUILD_STATES,
  REVIEW_SOURCES,
  RISK_TIERS,
  RUNTIMES,
  SEVERITIES,
  VERDICTS,
  VERIFICATIONS,
} from "@open-cr-agent/cloud-contract";
import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  type AgentPrefs,
  AUTOMATION_RUN_OUTCOMES,
  AUTOMATION_SKIP_REASONS,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationConditions,
  type AutomationRetry,
  type AutomationRunView,
  CODE_PLATFORMS,
  DISMISS_REASONS,
  FINDING_STATUSES,
  LIVE_ROLES,
  LIVE_STATES,
  type LinkedTaskView,
  MERGE_CHECK_KINDS,
  MERGE_CHECK_MODES,
  MERGE_INTENT_MODES,
  MERGE_INTENT_REASONS,
  MERGE_INTENT_STATES,
  MERGE_METHODS,
  type MergeCheckResultView,
  type MergeChecksConclusion,
  type MergeCheckVerdictView,
  type ModelChains,
  NOTIFY_KINDS,
  NOTIFY_WHEN,
  type NotifyEvent,
  type PullFilters,
  REVIEW_CHAT_ROLES,
  REVIEW_JOB_STATES,
  type ReviewerCounts,
  type ReviewSettings,
  type ReviewWalkthroughView,
  SIGN_IN_PROVIDERS,
} from "../shared/index.js";

// Every table but accounts carries accountId, and is read and written only
// through scoped() in ./scoped.ts, which filters by it. The isolation test
// fails when a table here has no case there.

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

const accountId = () =>
  text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    login: text("login").notNull(),
    // ADR-0028: findings and their quoted code are uploaded only when on.
    shareFindings: integer("share_findings", { mode: "boolean" }).notNull().default(false),
    // The repository-hash salt shared by the account's machines when sharing is on.
    salt: text("salt"),
    createdAt: createdAt(),
    // The last UTC day whose digest was sent, so that it goes once (src/notify/digest.ts).
    digestDay: text("digest_day"),
    // The weekly report's slot (UTC weekday 0 = Sunday, hour) and the last
    // slot sent, so that it goes once (src/notify/report.ts).
    reportWeekday: integer("report_weekday").notNull().default(1),
    reportHour: integer("report_hour").notNull().default(9),
    reportSentFor: integer("report_sent_for", { mode: "timestamp_ms" }),
    // When the inbox was first listed: a pull request with no read mark
    // updated before it reads as read (src/db/pull-seen.ts). Set once.
    inboxSince: integer("inbox_since", { mode: "timestamp_ms" }),
    // The IANA time zone a channel's quiet hours are read in (src/notify/reminders.ts).
    timeZone: text("time_zone").notNull().default("UTC"),
  },
  (t) => [index("accounts_login").on(t.login)],
);

// Who signs in as an account: a sign-in provider's user, by the id it never
// reuses (a GitHub user id, an OpenID Connect `sub`).
export const identities = sqliteTable(
  "identities",
  {
    provider: text("provider", { enum: SIGN_IN_PROVIDERS }).notNull(),
    subject: text("subject").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("identities_account").on(t.accountId),
  ],
);

// A signed-in browser or CLI. Only a hash of the token is stored.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind", { enum: ["web", "cli"] }).notNull(),
    label: text("label"),
    createdAt: createdAt(),
    // The access token's expiry. A CLI session also has a refresh token,
    // rotated on each use, that outlives it.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    refreshHash: text("refresh_hash").unique(),
    // Fixed when the CLI session starts: rotation does not extend it.
    refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    // The pair before the last rotation. The access token stays valid until its
    // own expiry, for another process still using it; the refresh token, once
    // used again, either answers a lost response (within REFRESH_GRACE_MS of
    // rotatedAt) or revokes the session as stolen.
    prevTokenHash: text("prev_token_hash"),
    prevExpiresAt: integer("prev_expires_at", { mode: "timestamp_ms" }),
    prevRefreshHash: text("prev_refresh_hash"),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("sessions_prev_token").on(t.prevTokenHash),
    index("sessions_prev_refresh").on(t.prevRefreshHash),
    index("sessions_account").on(t.accountId),
    // When the session ends (its last token expires), so retention finds
    // the ended ones without reading every session (audit C3).
    index("sessions_ends").on(sql`coalesce(${t.refreshExpiresAt}, ${t.expiresAt})`),
  ],
);

// An `ocra login` in progress (RFC 8628). It is found by its codes before
// any account is known, so it is not an account table: approvedAccountId is
// set when a signed-in user approves it, and the CLI session is made then.
export const deviceCodes = sqliteTable("device_codes", {
  id: text("id").primaryKey(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  label: text("label"),
  status: text("status", { enum: ["pending", "approved", "denied", "consumed"] })
    .notNull()
    .default("pending"),
  approvedAccountId: text("approved_account_id").references(() => accounts.id, {
    onDelete: "cascade",
  }),
  intervalSeconds: integer("interval_seconds").notNull().default(5),
  lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
});

// Counts of a UTC day for the caps no account can be held to: login codes
// are asked for before anyone signs in (audit C1). Kept for the day only.
export const serviceCounters = sqliteTable(
  "service_counters",
  {
    /** What is counted: "device_codes" for the service, "device_codes:<key>" per network. */
    name: text("name").notNull(),
    /** The UTC date, YYYY-MM-DD. */
    day: text("day").notNull(),
    n: integer("n").notNull().default(0),
  },
  // Day first: retention deletes past days by it.
  (t) => [primaryKey({ columns: [t.day, t.name] })],
);

/**
 * A rate limit's current window per key, for self-hosted servers that run
 * several processes against one database (RATE_LIMITS=database). Unused on
 * Workers, where the rate limiting bindings count.
 */
export const rateWindows = sqliteTable(
  "rate_windows",
  {
    /** The limit and what it counts, as "gateway:<account id>" or "device_codes:<address>". */
    key: text("key").primaryKey(),
    /** When the window began, in milliseconds. */
    start: integer("start").notNull(),
    n: integer("n").notNull(),
  },
  // Retention deletes windows long over by it.
  (t) => [index("rate_windows_start").on(t.start)],
);

// A model provider key, encrypted with a data key that the master key wraps.
export const providerKeys = sqliteTable(
  "provider_keys",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    provider: text("provider").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    last4: text("last4").notNull(),
    // The last check of the key against the provider: ok, invalid, error, or
    // unchecked when the provider has no way to check a key in advance.
    checkStatus: text("check_status", { enum: ["ok", "invalid", "error", "unchecked"] }),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  // One key per provider: a save replaces it in place (audit D-hyg).
  (t) => [uniqueIndex("provider_keys_account_provider").on(t.accountId, t.provider)],
);

// Review metadata the CLI uploads after a review: counts only. The
// repository is a hash salted on the user's machine, so the server cannot
// tell which repository it is; no paths, titles, findings text or code.
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    runId: text("run_id").notNull(),
    repoHash: text("repo_hash").notNull(),
    source: text("source", { enum: REVIEW_SOURCES }).notNull(),
    tier: text("tier", { enum: RISK_TIERS }),
    verdict: text("verdict", { enum: VERDICTS }),
    complete: integer("complete", { mode: "boolean" }).notNull().default(true),
    findings: integer("findings").notNull().default(0),
    critical: integer("critical").notNull().default(0),
    warning: integer("warning").notNull().default(0),
    suggestion: integer("suggestion").notNull().default(0),
    filesReviewed: integer("files_reviewed").notNull().default(0),
    filesNotReviewed: integer("files_not_reviewed").notNull().default(0),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    tasksFailed: integer("tasks_failed").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    ocraVersion: text("ocra_version"),
    // ADR-0038: the pull request a PR-mode review was of; null for other reviews.
    prRepository: text("pr_repository"),
    prNumber: integer("pr_number"),
    prHeadSha: text("pr_head_sha"),
    // The pull request's linked tasks as uploaded; null when the review did not look them up.
    linkedTasks: text("linked_tasks", { mode: "json" }).$type<LinkedTaskView[]>(),
    // The ids of the learnings the review was given; null when the upload did not say.
    learnings: text("learnings", { mode: "json" }).$type<(string | null)[]>(),
    // Its plain-language checks' outcomes; null when it was given none.
    mergeChecks: text("merge_checks", { mode: "json" }).$type<MergeCheckVerdictView[]>(),
    // ADR-0028, 1: numbers per reviewer and the run's outcomes; never text.
    byReviewer: text("by_reviewer", { mode: "json" }).$type<Record<string, ReviewerCounts>>(),
    verification: text("verification", { mode: "json" }).$type<Partial<Record<string, number>>>(),
    fixed: integer("fixed").notNull().default(0),
    dismissed: integer("dismissed").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reviews_account_run").on(t.accountId, t.runId),
    index("reviews_account_created").on(t.accountId, t.createdAt),
    // The inbox's verdict of each listed pull request: its newest review.
    index("reviews_account_pull").on(t.accountId, t.prNumber, t.createdAt),
  ],
);

// Settings of an account, one row: the default models for a review with no
// models configured (ADR-0024 zero configuration).
// One row per account, keyed by it: a save is an upsert on the account.
export const preferences = sqliteTable("preferences", {
  accountId: accountId().primaryKey(),
  models: text("models", { mode: "json" }).$type<ModelChains>(),
  // The runtime and per-agent settings (ADR-0025), layered under a
  // repository's configuration by the CLI.
  runtime: text("runtime", { enum: RUNTIMES }),
  agents: text("agents", { mode: "json" }).$type<AgentPrefs>(),
  // The review's data settings (ADR-0027): never providers, extends or botLogin.
  settings: text("settings", { mode: "json" }).$type<ReviewSettings>(),
  // The id of the preference_versions row these values are: a save sets it
  // only while it is still the version the save started from (audit C6).
  version: text("version"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

// Uses of a key and changes to an account, readable by its owner.
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    kind: text("kind").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_account_created").on(t.accountId, t.createdAt)],
);

// One model call through the gateway: the audit log of key use, and the
// usage behind the daily cap and statistics. Never a request or answer body.
export const gatewayCalls = sqliteTable(
  "gateway_calls",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    provider: text("provider").notNull(),
    path: text("path").notNull(),
    model: text("model"),
    status: integer("status").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    ms: integer("ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("gateway_calls_account_created").on(t.accountId, t.createdAt)],
);

// Each save of the preferences (ADR-0027): what was saved and which keys
// changed, so any version can be restored. The newest 50 are kept.
export const preferenceVersions = sqliteTable(
  "preference_versions",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    snapshot: text("snapshot", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    changed: text("changed", { mode: "json" }).notNull().$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [index("preference_versions_account_created").on(t.accountId, t.createdAt)],
);

// A finding of an uploaded review, only while the account shares findings
// (ADR-0028). Redacted and bounded; deleted with its review.
export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    reviewer: text("reviewer").notNull(),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    category: text("category"),
    verification: text("verification", { enum: VERIFICATIONS }),
    file: text("file").notNull(),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    suggestion: text("suggestion"),
    code: text("code"),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    // What the account decided about the finding in the console; after
    // createdAt, in the order the migration added them (insertReview names
    // every column in this order).
    status: text("status", { enum: FINDING_STATUSES }).notNull().default("open"),
    reason: text("reason", { enum: DISMISS_REASONS }),
    note: text("note"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    // Where the finding was in the upload: the report's order, kept on any database.
    position: integer("position").notNull().default(0),
    // Its fix as the CLI sent it, unredacted and whole (the contract's
    // sharedFixSchema): lines of the reviewed head and their replacement.
    fixStartLine: integer("fix_start_line"),
    fixEndLine: integer("fix_end_line"),
    fixReplacement: text("fix_replacement"),
  },
  // review_id: a review's delete cascades here (by the user or retention).
  // findings_account_status_created leads with account_id, so it also
  // serves every read by account: one index per finding row written.
  (t) => [
    index("findings_review").on(t.reviewId),
    index("findings_account_status_created").on(t.accountId, t.status, t.createdAt, t.id),
  ],
);

// A review's walkthrough of the change (ADR-0047 of the engine), kept as
// shared findings are: only while the account shares them, redacted again
// on the server, and gone with its review.
export const reviewWalkthroughs = sqliteTable(
  "review_walkthroughs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    overview: text("overview").notNull(),
    groups: text("groups", { mode: "json" }).$type<ReviewWalkthroughView["groups"]>().notNull(),
    diagram: text("diagram"),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("review_walkthroughs_review").on(t.reviewId),
    index("review_walkthroughs_account_created").on(t.accountId, t.createdAt),
  ],
);

// Findings the account remembers (ADR-0028, 4), applied with a repository's
// .ocra/memory.json. Kept until deleted; at most 500 per repository.
export const accountMemory = sqliteTable(
  "account_memory",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    repoHash: text("repo_hash").notNull(),
    fingerprint: text("fingerprint").notNull(),
    file: text("file"),
    title: text("title"),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("account_memory_account_created").on(t.accountId, t.createdAt),
    index("account_memory_repo_created").on(t.accountId, t.repoHash, t.createdAt),
  ],
);

// What an account used on a UTC day, counted as it happens, so a cap is
// checked by reading a row or a few instead of counting the account's
// records (audit C1). Kept RETENTION_DAYS, like the records.
export const usageCounters = sqliteTable(
  "usage_counters",
  {
    accountId: accountId(),
    kind: text("kind", {
      enum: ["uploads", "gateway_calls", "findings", "email_confirmations"],
    }).notNull(),
    /** The UTC date, YYYY-MM-DD. */
    day: text("day").notNull(),
    n: integer("n").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.kind, t.day] })],
);

// The account's token on a code platform (GitHub, GitLab, a self-hosted
// GitLab), one per platform and host, encrypted like a provider key and
// bound to the account, so the console can read what the user reaches
// there. Dropped when it no longer decrypts or its refresh is refused; the
// next connection stores a new one.
export const platformLinks = sqliteTable(
  "platform_links",
  {
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    /** The platform's host, such as github.com or gitlab.example.com. */
    host: text("host").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    // The platform's id of the user the token is of (GitLab), which says
    // which pull request events are this account's own.
    userId: text("user_id"),
    accessExpiresAt: integer("access_expires_at", { mode: "timestamp_ms" }),
    refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.platform, t.host] })],
);

// The account's own limits, under the service's: one row per account.
// dailyCalls caps the gateway's calls a UTC day; null leaves the service's.
export const budgets = sqliteTable("budgets", {
  accountId: accountId().primaryKey(),
  dailyCalls: integer("daily_calls"),
  createdAt: createdAt(),
});

// The name the account gave a repository the CLI knows only by its hash
// (ADR-0028 keeps uploads to the hash). Kept until the account clears it.
export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    repoHash: text("repo_hash").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repositories_account_repo").on(t.accountId, t.repoHash)],
);

// The account's own inbox sections, in position order, one name once.
export const pullViews = sqliteTable(
  "pull_views",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    name: text("name").notNull(),
    filters: text("filters", { mode: "json" }).$type<PullFilters>().notNull(),
    position: integer("position").notNull(),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("pull_views_account_position").on(t.accountId, t.position),
    uniqueIndex("pull_views_account_name").on(t.accountId, t.name),
  ],
);

// When the account last saw each pull request: the platform's updated_at
// and head it saw then, so the inbox tells what changed since. A mark never
// moves to an older updated_at; `unread` is the account's own "unread again".
export const pullSeen = sqliteTable(
  "pull_seen",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    // Lower case: platforms compare repository paths without case.
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    head: text("head"),
    unread: integer("unread", { mode: "boolean" }).notNull().default(false),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pull_seen_account_pull").on(t.accountId, t.platform, t.repo, t.number),
    index("pull_seen_account_seen").on(t.accountId, t.seenAt),
  ],
);

// The files of a GitLab merge request the account ticked as viewed, with
// the file's version then (a hash of its diff, src/platforms/gitlab-changes.ts):
// a tick counts only while the version matches, so a file that changed in a
// later head reads as not viewed. GitHub keeps its own (viewerViewedState).
export const pullFileViews = sqliteTable(
  "pull_file_views",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    // Lower case: platforms compare repository paths without case.
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    path: text("path").notNull(),
    sha: text("sha").notNull(),
    viewedAt: integer("viewed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pull_file_views_file").on(t.accountId, t.platform, t.repo, t.number, t.path),
    index("pull_file_views_account_viewed").on(t.accountId, t.viewedAt),
  ],
);

// A repository whose default branch the account has the server keep a code
// graph of: symbol names, kinds and line numbers per file, never code. Found
// by a push webhook through (platform, host, platform_repo_id); a GitLab
// project's hook proves itself with the secret whose hash is kept here.
export const graphRepos = sqliteTable(
  "graph_repos",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    host: text("host").notNull(),
    platformRepoId: text("platform_repo_id").notNull(),
    fullName: text("full_name").notNull(),
    branch: text("branch").notNull(),
    webhookSecretHash: text("webhook_secret_hash"),
    // When the account agreed to keep the graph, where the deployment asks.
    consentedAt: integer("consented_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("graph_repos_account_repo").on(t.accountId, t.platform, t.host, t.platformRepoId),
    index("graph_repos_platform_repo").on(t.platform, t.host, t.platformRepoId),
  ],
);

// One build of a graph repository's commit, from queued to done; a done
// build holds the engine's serialized graph, gzipped, as opaque bytes.
export const graphBuilds = sqliteTable(
  "graph_builds",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    graphRepoId: text("graph_repo_id")
      .notNull()
      .references(() => graphRepos.id, { onDelete: "cascade" }),
    commit: text("commit").notNull(),
    state: text("state", { enum: GRAPH_BUILD_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    notBefore: integer("not_before", { mode: "timestamp_ms" }),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    error: text("error"),
    content: blob("content", { mode: "buffer" }),
    bytes: integer("bytes"),
    files: integer("files"),
    parsed: integer("parsed"),
    reused: integer("reused"),
    skipped: integer("skipped"),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("graph_builds_repo_commit").on(t.graphRepoId, t.commit),
    index("graph_builds_state").on(t.state, t.createdAt),
    index("graph_builds_account_created").on(t.accountId, t.createdAt),
  ],
);

// A repository whose pull requests the server reviews itself (ADR-0046).
// One account enrolls it and pays for its reviews: platform, host and id
// are unique across accounts.
export const reviewRepos = sqliteTable(
  "review_repos",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    host: text("host").notNull(),
    platformRepoId: text("platform_repo_id").notNull(),
    fullName: text("full_name").notNull(),
    webhookSecretHash: text("webhook_secret_hash"),
    createdAt: createdAt(),
    /** Whether a blocking check that waits on the head's review keeps the merge pending. */
    holdUnreviewed: integer("hold_unreviewed", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    uniqueIndex("review_repos_platform_repo").on(t.platform, t.host, t.platformRepoId),
    index("review_repos_account").on(t.accountId),
  ],
);

// A chat or an email address the account's reviews are announced in: the
// webhook's address or the email address, encrypted like a model key (a
// webhook is the chat's credential). An email address gets nothing until
// the link sent to it is opened: only its token's hash is kept, until then.
export const notifyChannels = sqliteTable(
  "notify_channels",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    kind: text("kind", { enum: NOTIFY_KINDS }).notNull(),
    name: text("name").notNull(),
    when: text("when", { enum: NOTIFY_WHEN }).notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    last4: text("last4").notNull(),
    lastStatus: text("last_status", { enum: ["ok", "failed"] }),
    lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    confirmTokenHash: text("confirm_token_hash"),
    confirmExpiresAt: integer("confirm_expires_at", { mode: "timestamp_ms" }),
    digest: integer("digest", { mode: "boolean" }).notNull().default(false),
    weekly: integer("weekly", { mode: "boolean" }).notNull().default(false),
    events: text("events", { mode: "json" }).$type<NotifyEvent[]>().notNull().default([]),
    // After how many hours a waiting pull request is a reminder; none when null.
    reminderHours: integer("reminder_hours"),
    // The hours, in the account's time zone, no reminder goes: from start up to end.
    quietStart: integer("quiet_start"),
    quietEnd: integer("quiet_end"),
  },
  (t) => [index("notify_channels_account").on(t.accountId)],
);

// A pull request event a channel was told of (src/notify/pull-events.ts),
// kept so that a webhook delivered twice tells it once: the event is
// claimed here before its message goes. Kept a month.
export const notifySends = sqliteTable(
  "notify_sends",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    channelId: text("channel_id").notNull(),
    eventKey: text("event_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notify_sends_channel_event").on(t.channelId, t.eventKey),
    index("notify_sends_account_created").on(t.accountId, t.createdAt),
  ],
);

// An enrolled repository's pull request as its platform said it ended:
// merged or closed, one row per pull request; a later close (after a
// reopen) replaces an earlier one. The title is the platform's, as sent.
export const closedPulls = sqliteTable(
  "closed_pulls",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    merged: integer("merged", { mode: "boolean" }).notNull(),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("closed_pulls_pull").on(t.reviewRepoId, t.number),
    index("closed_pulls_account_closed").on(t.accountId, t.closedAt),
  ],
);

// How an enrolled repository's pull request moved before it ended, from
// its platform's webhooks (src/auto-review/flows.ts): one row per pull
// request. The first times keep the earliest delivered; title, author,
// size and draft the latest. seen_at is the last event, for retention.
export const pullFlows = sqliteTable(
  "pull_flows",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    // The platform's id of the author, which outlives a renamed login.
    authorId: text("author_id"),
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    // Lines added plus deleted, where the platform says (GitHub).
    size: integer("size"),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    readyAt: integer("ready_at", { mode: "timestamp_ms" }),
    reopenedAt: integer("reopened_at", { mode: "timestamp_ms" }),
    firstReviewRequestedAt: integer("first_review_requested_at", { mode: "timestamp_ms" }),
    firstReviewAt: integer("first_review_at", { mode: "timestamp_ms" }),
    firstApprovalAt: integer("first_approval_at", { mode: "timestamp_ms" }),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pull_flows_pull").on(t.reviewRepoId, t.number),
    index("pull_flows_account_seen").on(t.accountId, t.seenAt),
  ],
);

// A review someone other than the author submitted on an enrolled
// repository's pull request, once per platform review (an approval on
// GitLab, once per approver), for reviewer load.
export const pullReviews = sqliteTable(
  "pull_reviews",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    reviewKey: text("review_key").notNull(),
    reviewer: text("reviewer").notNull(),
    approved: integer("approved", { mode: "boolean" }).notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pull_reviews_review").on(t.reviewRepoId, t.reviewKey),
    index("pull_reviews_account_submitted").on(t.accountId, t.submittedAt),
  ],
);

// The directories a reviewed pull request of an enrolled repository
// changes, top-level and second-level, at most MAX_PULL_PREFIXES of them,
// as read at the head its latest review saw, for suggested reviewers
// (src/review-paths.ts). A newer head replaces the set.
export const pullPaths = sqliteTable(
  "pull_paths",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    head: text("head").notNull(),
    prefix: text("prefix").notNull(),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pull_paths_prefix").on(t.reviewRepoId, t.number, t.prefix),
    index("pull_paths_account_seen").on(t.accountId, t.seenAt),
  ],
);

// A review asked of a user on an enrolled repository's pull request, from
// its platform's webhooks (src/auto-review/requests.ts): one row per pull
// request and reviewer, by the platform's id of the reviewer. A later ask
// moves requested_at, the reviewer's review or the ask's removal done_at;
// the ask still waits while done_at is before requested_at. For reminders.
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    // The reviewer's login when asked, where the event names it.
    reviewer: text("reviewer"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    doneAt: integer("done_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("review_requests_pull_reviewer").on(t.reviewRepoId, t.number, t.reviewerId),
    index("review_requests_account_requested").on(t.accountId, t.requestedAt),
  ],
);

// One review of a pull request's head, from queued to done; a newer head
// of the same pull request supersedes the queued ones. A head is reviewed
// again (asked for on the console) as its next run.
export const reviewJobs = sqliteTable(
  "review_jobs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    head: text("head").notNull(),
    run: integer("run").notNull().default(0),
    state: text("state", { enum: REVIEW_JOB_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    notBefore: integer("not_before", { mode: "timestamp_ms" }),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    error: text("error"),
    reviewId: text("review_id"),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("review_jobs_pull_head_run").on(t.reviewRepoId, t.number, t.head, t.run),
    index("review_jobs_state").on(t.state, t.createdAt),
    index("review_jobs_account_created").on(t.accountId, t.createdAt),
  ],
);

// An answer to an @ocra comment on an enrolled repository's pull request,
// one per comment: a webhook retried or delivered twice queues it once.
export const replyJobs = sqliteTable(
  "reply_jobs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    commentId: text("comment_id").notNull(),
    // A review comment on a line (GitHub's pull_request_review_comment).
    inline: integer("inline", { mode: "boolean" }).notNull().default(false),
    state: text("state", { enum: REVIEW_JOB_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    notBefore: integer("not_before", { mode: "timestamp_ms" }),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    error: text("error"),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reply_jobs_comment").on(t.reviewRepoId, t.commentId),
    index("reply_jobs_state").on(t.state, t.createdAt),
    index("reply_jobs_account_created").on(t.accountId, t.createdAt),
  ],
);

// Tests or docstrings generated on an enrolled repository's pull request and
// committed to its branch by the bot: one per head and kind, so a second
// click on the same commit queues nothing.
export const generateJobs = sqliteTable(
  "generate_jobs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    head: text("head").notNull(),
    kind: text("kind", { enum: GENERATE_KINDS }).notNull(),
    state: text("state", { enum: REVIEW_JOB_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    notBefore: integer("not_before", { mode: "timestamp_ms" }),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    error: text("error"),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("generate_jobs_pull_head_kind").on(t.reviewRepoId, t.number, t.head, t.kind),
    index("generate_jobs_state").on(t.state, t.createdAt),
    index("generate_jobs_account_pull").on(t.accountId, t.reviewRepoId, t.number),
  ],
);

// A rule the account set for its pull requests (src/automations/).
export const automationRules = sqliteTable(
  "automation_rules",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    trigger: text("trigger", { enum: AUTOMATION_TRIGGERS }).notNull(),
    conditions: text("conditions", { mode: "json" }).$type<AutomationConditions>().notNull(),
    actions: text("actions", { mode: "json" }).$type<AutomationAction[]>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("automation_rules_account_trigger").on(t.accountId, t.trigger)],
);

// One run of a rule on one event: a webhook delivered twice, or an upload
// retried, finds its event key taken and runs nothing. Kept after its rule
// is deleted, until retention.
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    ruleId: text("rule_id").notNull(),
    ruleName: text("rule_name").notNull(),
    trigger: text("trigger", { enum: AUTOMATION_TRIGGERS }).notNull(),
    pull: text("pull").notNull(),
    eventKey: text("event_key").notNull(),
    outcome: text("outcome", { enum: AUTOMATION_RUN_OUTCOMES }).notNull().default("running"),
    reason: text("reason", { enum: AUTOMATION_SKIP_REASONS }),
    actions: text("actions", { mode: "json" }).$type<AutomationRunView["actions"]>().notNull(),
    attempts: integer("attempts").notNull().default(1),
    // The actions the platform did not answer, tried again at retryAt; a
    // runner claims the attempt by moving retryAt past its lease.
    retry: text("retry", { mode: "json" }).$type<AutomationRetry>(),
    retryAt: integer("retry_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("automation_runs_rule_event").on(t.ruleId, t.eventKey),
    index("automation_runs_account_created").on(t.accountId, t.createdAt),
    index("automation_runs_retry").on(t.retryAt),
  ],
);

// A pre-merge check an account asks of an enrolled repository's pull
// requests; its settings are checked against its kind's schema on the way
// in and out (src/merge-checks/settings.ts).
export const mergeChecks = sqliteTable(
  "merge_checks",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MERGE_CHECK_KINDS }).notNull(),
    mode: text("mode", { enum: MERGE_CHECK_MODES }).notNull(),
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("merge_checks_repo").on(t.reviewRepoId, t.createdAt),
    index("merge_checks_account").on(t.accountId),
  ],
);

// How one head of a pull request fared, one row per head: posted to the
// platform when its digest changes, so a result is posted once.
export const mergeCheckRuns = sqliteTable(
  "merge_check_runs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewRepoId: text("review_repo_id")
      .notNull()
      .references(() => reviewRepos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    head: text("head").notNull(),
    conclusion: text("conclusion", { enum: ["success", "neutral", "failure", "pending"] })
      .$type<MergeChecksConclusion>()
      .notNull(),
    results: text("results", { mode: "json" }).$type<MergeCheckResultView[]>().notNull(),
    digest: text("digest").notNull(),
    postedDigest: text("posted_digest"),
    // The platform's id of the check run, to update it rather than add another.
    externalId: text("external_id"),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("merge_check_runs_head").on(t.reviewRepoId, t.number, t.head),
    index("merge_check_runs_account_created").on(t.accountId, t.createdAt),
  ],
);

// A pull request the account set to merge when ready (src/merge-when-ready/):
// one row per pull request, re-armed in place. The repository's path is
// kept lowercased, as its webhooks are matched to it. claimed_at is the
// compare-and-set of the one runner that merges it.
export const mergeIntents = sqliteTable(
  "merge_intents",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    platform: text("platform", { enum: CODE_PLATFORMS }).notNull(),
    host: text("host").notNull(),
    fullName: text("full_name").notNull(),
    number: integer("number").notNull(),
    method: text("method", { enum: MERGE_METHODS }).notNull(),
    mode: text("mode", { enum: MERGE_INTENT_MODES }).notNull(),
    head: text("head").notNull(),
    keepOnPush: integer("keep_on_push", { mode: "boolean" }).notNull().default(false),
    state: text("state", { enum: MERGE_INTENT_STATES }).notNull(),
    reason: text("reason", { enum: MERGE_INTENT_REASONS }),
    armedBy: text("armed_by").notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    uniqueIndex("merge_intents_pull").on(t.accountId, t.platform, t.host, t.fullName, t.number),
    index("merge_intents_head").on(t.accountId, t.platform, t.host, t.fullName, t.head),
    index("merge_intents_account_updated").on(t.accountId, t.updatedAt),
  ],
);

// "Ask ocra" about a review: the account's questions and the answers, kept
// as long as the review (deleted with it, by the user or retention) and at
// most MAX_CHAT_MESSAGES of them (./review-chat.ts).
export const reviewChatMessages = sqliteTable(
  "review_chat_messages",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    role: text("role", { enum: REVIEW_CHAT_ROLES }).notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  // review_id first for the delete's cascade; the account's reads go by
  // (account_id, review_id, created_at).
  (t) => [
    index("review_chat_messages_review").on(t.reviewId),
    index("review_chat_messages_account_review").on(t.accountId, t.reviewId, t.createdAt),
  ],
);

// A review relayed while it runs (ADR-0056), by the CLI's run id; its
// events are kept by seq, first write wins. The share link, while it is on,
// is an HMAC of linkNonce (src/live/link.ts); a new nonce replaces it.
export const liveRuns = sqliteTable(
  "live_runs",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    runId: text("run_id").notNull(),
    repoHash: text("repo_hash").notNull(),
    source: text("source", { enum: REVIEW_SOURCES }).notNull(),
    prRepository: text("pr_repository"),
    prNumber: integer("pr_number"),
    target: text("target").notNull().default(""),
    state: text("state", { enum: LIVE_STATES }).notNull().default("running"),
    verdict: text("verdict", { enum: VERDICTS }),
    events: integer("events").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    linkNonce: text("link_nonce"),
    linkRole: text("link_role", { enum: LIVE_ROLES }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("live_runs_account_run").on(t.accountId, t.runId),
    index("live_runs_account_updated").on(t.accountId, t.updatedAt),
  ],
);

export const liveEvents = sqliteTable(
  "live_events",
  {
    accountId: accountId(),
    liveRunId: text("live_run_id")
      .notNull()
      .references(() => liveRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    at: text("at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.liveRunId, t.seq] }),
    index("live_events_account_run").on(t.accountId, t.liveRunId, t.seq),
  ],
);

// Who else the owner lets see a run, and whether they may comment.
export const liveGrants = sqliteTable(
  "live_grants",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    liveRunId: text("live_run_id")
      .notNull()
      .references(() => liveRuns.id, { onDelete: "cascade" }),
    granteeId: text("grantee_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text("role", { enum: LIVE_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("live_grants_run_grantee").on(t.liveRunId, t.granteeId),
    index("live_grants_account_run").on(t.accountId, t.liveRunId, t.createdAt),
    index("live_grants_grantee").on(t.granteeId, t.createdAt),
  ],
);

// What the owner and the people they let comment wrote about the run; a
// finding's comment names it by the run's finding id.
export const liveComments = sqliteTable(
  "live_comments",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    liveRunId: text("live_run_id")
      .notNull()
      .references(() => liveRuns.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => accounts.id, { onDelete: "set null" }),
    authorLogin: text("author_login").notNull(),
    findingId: text("finding_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("live_comments_run_created").on(t.liveRunId, t.createdAt),
    index("live_comments_account_created").on(t.accountId, t.createdAt),
  ],
);

/** The tables scoped by account, by the name scoped() uses. */
export const accountTables = {
  sessions,
  providerKeys,
  reviews,
  auditEvents,
  gatewayCalls,
  preferences,
  preferenceVersions,
  findings,
  accountMemory,
  usageCounters,
  repositories,
  budgets,
  platformLinks,
  pullViews,
  pullSeen,
  pullFileViews,
  graphRepos,
  graphBuilds,
  reviewRepos,
  reviewJobs,
  notifyChannels,
  notifySends,
  closedPulls,
  pullFlows,
  pullReviews,
  pullPaths,
  reviewRequests,
  replyJobs,
  reviewWalkthroughs,
  generateJobs,
  automationRules,
  automationRuns,
  mergeChecks,
  mergeCheckRuns,
  mergeIntents,
  reviewChatMessages,
  liveRuns,
  liveEvents,
  liveGrants,
  liveComments,
} as const;
