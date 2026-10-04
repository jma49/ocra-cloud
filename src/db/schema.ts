import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
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

// Review metadata the CLI uploads. The repository is a salted hash unless
// the user opts in to sending its name.
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  accountId: accountId(),
  repoHash: text("repo_hash").notNull(),
  verdict: text("verdict"),
  findings: integer("findings").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  createdAt: createdAt(),
});

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

/** The tables scoped by account, by the name scoped() uses. */
export const accountTables = {
  sessions,
  providerKeys,
  reviews,
  auditEvents,
  gatewayCalls,
} as const;
