import {
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
  CODE_PLATFORMS,
  DISMISS_REASONS,
  FINDING_STATUSES,
  GRAPH_BUILD_STATES,
  type ModelChains,
  type PullFilters,
  REVIEW_JOB_STATES,
  type ReviewerCounts,
  type ReviewSettings,
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

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  login: text("login").notNull(),
  // ADR-0028: findings and their quoted code are uploaded only when on.
  shareFindings: integer("share_findings", { mode: "boolean" }).notNull().default(false),
  // The repository-hash salt shared by the account's machines when sharing is on.
  salt: text("salt"),
  createdAt: createdAt(),
});

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
  },
  // review_id: a review's delete cascades here (by the user or retention).
  // findings_account_status_created leads with account_id, so it also
  // serves every read by account: one index per finding row written.
  (t) => [
    index("findings_review").on(t.reviewId),
    index("findings_account_status_created").on(t.accountId, t.status, t.createdAt, t.id),
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
    kind: text("kind", { enum: ["uploads", "gateway_calls", "findings"] }).notNull(),
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

// The account's own inbox sections, after the fixed ones, in position order.
export const pullViews = sqliteTable(
  "pull_views",
  {
    id: text("id").primaryKey(),
    accountId: accountId(),
    name: text("name").notNull(),
    filters: text("filters", { mode: "json" }).$type<PullFilters>().notNull(),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pull_views_account_position").on(t.accountId, t.position)],
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
  },
  (t) => [
    uniqueIndex("review_repos_platform_repo").on(t.platform, t.host, t.platformRepoId),
    index("review_repos_account").on(t.accountId),
  ],
);

// One review of a pull request's head, from queued to done; a newer head
// of the same pull request supersedes the queued ones.
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
    uniqueIndex("review_jobs_pull_head").on(t.reviewRepoId, t.number, t.head),
    index("review_jobs_state").on(t.state, t.createdAt),
    index("review_jobs_account_created").on(t.accountId, t.createdAt),
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
  graphRepos,
  graphBuilds,
  reviewRepos,
  reviewJobs,
} as const;
