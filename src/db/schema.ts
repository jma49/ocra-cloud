import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentPrefs, ModelChains, ReviewSettings } from "../api-types.js";

export type { AgentPrefs, Effort, ReviewSettings } from "../api-types.js";

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
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull(),
  // ADR-0028: findings and their quoted code are uploaded only when on.
  shareFindings: integer("share_findings", { mode: "boolean" }).notNull().default(false),
  // The repository-hash salt shared by the account's machines when sharing is on.
  salt: text("salt"),
  createdAt: createdAt(),
});

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
  (t) => [index("provider_keys_account").on(t.accountId)],
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
    source: text("source").notNull(),
    tier: text("tier"),
    verdict: text("verdict"),
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
    // ADR-0028, 1: numbers per reviewer and the run's outcomes; never text.
    byReviewer: text("by_reviewer", { mode: "json" }).$type<Record<string, ReviewerCounts>>(),
    verification: text("verification", { mode: "json" }).$type<Record<string, number>>(),
    fixed: integer("fixed").notNull().default(0),
    dismissed: integer("dismissed").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reviews_account_run").on(t.accountId, t.runId),
    index("reviews_account_created").on(t.accountId, t.createdAt),
  ],
);

export type ReviewerCounts = {
  tasks: number;
  failedTasks: number;
  findings: { critical: number; warning: number; suggestion: number };
  costUsd: number;
  fixed: number;
  dismissed: number;
};

// Settings of an account, one row: the default models for a review with no
// models configured (ADR-0024 zero configuration).
export const preferences = sqliteTable("preferences", {
  id: text("id").primaryKey(),
  accountId: accountId().unique(),
  models: text("models", { mode: "json" }).$type<ModelChains>(),
  // The runtime and per-agent settings (ADR-0025), layered under a
  // repository's configuration by the CLI.
  runtime: text("runtime", { enum: ["direct", "opencode"] }),
  agents: text("agents", { mode: "json" }).$type<AgentPrefs>(),
  // The review's data settings (ADR-0027): never providers, extends or botLogin.
  settings: text("settings", { mode: "json" }).$type<ReviewSettings>(),
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
    severity: text("severity").notNull(),
    category: text("category"),
    verification: text("verification"),
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
  },
  // review_id: a review's delete cascades here (by the user or retention).
  (t) => [index("findings_account").on(t.accountId), index("findings_review").on(t.reviewId)],
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
  (t) => [index("account_memory_account").on(t.accountId)],
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
} as const;
