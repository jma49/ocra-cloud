import type * as schema from "../src/db/schema.js";
import { DAY } from "../src/time.js";

// One row per account-scoped table. A table added to the schema without a
// case here fails to compile (and the isolation test).
export const rows = {
  sessions: (id: string) => ({
    id,
    tokenHash: `hash-${id}`,
    kind: "cli" as const,
    expiresAt: new Date(Date.now() + DAY),
  }),
  providerKeys: (id: string) => ({
    id,
    provider: "openrouter",
    wrappedKey: "w",
    ciphertext: "c",
    last4: "abcd",
  }),
  reviews: (id: string) => ({ id, runId: `run-${id}`, repoHash: "r", source: "local" as const }),
  auditEvents: (id: string) => ({ id, kind: "key.used", detail: { model: "m" } }),
  gatewayCalls: (id: string) => ({
    id,
    provider: "openrouter",
    path: "/v1/chat/completions",
    status: 200,
  }),
  preferences: (_id: string) => ({ models: { standard: ["ocra-openrouter/m"] } }),
  preferenceVersions: (id: string) => ({ id, snapshot: { models: {} }, changed: ["models"] }),
  // The review it belongs to is made in beforeEach (the foreign key needs one).
  findings: (id: string) => ({
    id,
    reviewId: "review-of-a",
    fingerprint: `fp-${id}`,
    reviewer: "security",
    severity: "warning" as const,
    file: "a.ts",
    title: "t",
    body: "b",
  }),
  accountMemory: (id: string) => ({
    id,
    repoHash: "h",
    fingerprint: `fp-${id}`,
    reason: "accepted",
  }),
  budgets: (_id: string) => ({ dailyCalls: 100 }),
  repositories: (id: string) => ({ id, repoHash: `h-${id}`, name: `octo/${id}` }),
  // One row per account, kind and day; the id names the day.
  usageCounters: (id: string) => ({ kind: "uploads" as const, day: id, n: 1 }),
} satisfies { [N in keyof typeof schema.accountTables]: (id: string) => unknown };
