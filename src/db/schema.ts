import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  createdAt: createdAt(),
});

// A signed-in browser or CLI. Only a hash of the token is stored.
export const sessions = sqliteTable("sessions", {
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
  refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp_ms" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
});

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
export const providerKeys = sqliteTable("provider_keys", {
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
});

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
  (t) => [uniqueIndex("reviews_account_run").on(t.accountId, t.runId)],
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
  models: text("models", { mode: "json" }).$type<{
    top?: string[];
    standard?: string[];
    light?: string[];
  }>(),
  // The runtime and per-agent settings (ADR-0025), layered under a
  // repository's configuration by the CLI.
  runtime: text("runtime", { enum: ["direct", "opencode"] }),
  agents: text("agents", { mode: "json" }).$type<AgentPrefs>(),
  // The review's data settings (ADR-0027): never providers, extends or botLogin.
  settings: text("settings", { mode: "json" }).$type<ReviewSettings>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export type ReviewSettings = {
  ultra?: boolean;
  concurrency?: number;
  taskTimeoutMinutes?: number;
  runTimeoutMinutes?: number;
  maxCostUsd?: number;
  maxTasks?: number;
  verify?: boolean;
  judge?: boolean;
  sampling?: { temperature?: number; seed?: number };
  include?: string[];
  exclude?: string[];
  rules?: { path: string | string[]; rule: string }[];
  plugins?: string[];
  pluginSettings?: Record<string, unknown>;
};

export type Effort = "none" | "minimal" | "low" | "medium" | "high";
export type AgentPrefs = {
  effort?: { top?: Effort; standard?: Effort; light?: Effort };
  reviewers?: Record<string, { enabled?: boolean; models?: string[]; effort?: Effort }>;
  roles?: Partial<Record<"verifier" | "judge" | "helper", { models?: string[]; effort?: Effort }>>;
};

// Uses of a key and changes to an account, readable by its owner.
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  accountId: accountId(),
  kind: text("kind").notNull(),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

// One model call through the gateway: the audit log of key use, and the
// usage behind the daily cap and statistics. Never a request or answer body.
export const gatewayCalls = sqliteTable("gateway_calls", {
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
});

// Each save of the preferences (ADR-0027): what was saved and which keys
// changed, so any version can be restored. The newest 50 are kept.
export const preferenceVersions = sqliteTable("preference_versions", {
  id: text("id").primaryKey(),
  accountId: accountId(),
  snapshot: text("snapshot", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  changed: text("changed", { mode: "json" }).notNull().$type<string[]>(),
  createdAt: createdAt(),
});

/** The tables scoped by account, by the name scoped() uses. */
export const accountTables = {
  sessions,
  providerKeys,
  reviews,
  auditEvents,
  gatewayCalls,
  preferences,
  preferenceVersions,
} as const;
