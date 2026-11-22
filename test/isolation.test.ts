import { env } from "cloudflare:workers";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { rows } from "./table-rows.js";

const db = drizzle(env.DB);
const A = "acct-a";
const B = "acct-b";

// A change to one column of each table's row.
const changes = {
  sessions: { label: "changed" },
  providerKeys: { last4: "zzzz" },
  reviews: { findings: 9 },
  auditEvents: { kind: "changed" },
  gatewayCalls: { status: 500 },
  preferences: { models: { light: ["ocra-openrouter/x"] } },
  preferenceVersions: { changed: ["runtime"] },
  findings: { severity: "critical" },
  accountMemory: { reason: "changed" },
  usageCounters: { n: 9 },
  repositories: { name: "octo/changed" },
  budgets: { dailyCalls: 7 },
  platformLinks: { ciphertext: "changed" },
  pullViews: { name: "changed" },
  pullSeen: { unread: true },
  graphRepos: { branch: "trunk" },
  graphBuilds: { state: "done" as const },
  reviewRepos: { fullName: "octo/renamed" },
  reviewJobs: { state: "done" as const },
  notifyChannels: { name: "renamed" },
  notifySends: { eventKey: "changed" },
  closedPulls: { merged: false },
  pullFlows: { draft: true },
  pullReviews: { approved: false },
  pullPaths: { head: "d".repeat(40) },
  reviewRequests: { doneAt: new Date(0) },
  replyJobs: { state: "done" as const },
  reviewWalkthroughs: { overview: "changed" },
  generateJobs: { state: "done" as const },
  automationRules: { name: "renamed" },
  automationRuns: { outcome: "failed" as const },
  mergeChecks: { mode: "block" as const },
  mergeCheckRuns: { conclusion: "failure" as const },
  mergeIntents: { state: "cancelled" as const },
  reviewChatMessages: { text: "changed" },
  liveRuns: { target: "changed" },
  liveEvents: { kind: "changed" },
  liveGrants: { role: "comment" as const },
  liveComments: { body: "changed" },
} satisfies { [N in keyof typeof rows]: Record<string, unknown> };

// Storage persists across tests in a file; deleting the accounts cascades.
beforeEach(async () => {
  await db.delete(schema.accounts);
  await db.insert(schema.accounts).values([
    { id: A, login: "a" },
    { id: B, login: "b" },
  ]);
});

// Tables that reference an account but are deliberately not scoped by it,
// with the reason. Any other table with a foreign key to accounts must be in
// accountTables (and so get the cases below).
const unscoped: Record<string, string> = {
  // An `ocra login` in progress is found by its codes before any account is
  // known; approved_account_id is only set when a signed-in user approves it.
  // Only src/db/device.ts reads it, by code (test/device.test.ts).
  device_codes: "found by its codes before the account is known",
  // Signing in finds the account by its identity; only src/db/accounts.ts
  // reads it (test/identities.test.ts).
  identities: "found by provider and subject before the account is known",
};

// Columns of a scoped table that name an account other than its owner.
const otherAccounts: Record<string, string[]> = {
  // Whom the owner shares a live run with (src/db/live-access.ts reads it).
  live_grants: ["grantee_id"],
  // Who wrote a comment on the owner's live run.
  live_comments: ["author_id"],
};

const schemaTables = (Object.values(schema) as unknown[]).filter((t): t is SQLiteTable =>
  is(t, SQLiteTable),
);

/** The columns of a table that reference accounts, by any name. */
const accountReferences = (t: SQLiteTable) =>
  getTableConfig(t).foreignKeys.flatMap((fk) => {
    const ref = fk.reference();
    return ref.foreignTable === schema.accounts ? ref.columns.map((c) => c.name) : [];
  });

it("covers every table with a foreign key to accounts, whatever the column's name", () => {
  const referencing = schemaTables.filter((t) => accountReferences(t).length > 0);
  const scopedSet = new Set<SQLiteTable>(Object.values(schema.accountTables));
  // The check sees a reference under another name (device_codes.approved_account_id).
  expect(referencing.map((t) => getTableName(t))).toContain("device_codes");
  for (const t of referencing) {
    const name = getTableName(t);
    if (name in unscoped) {
      expect(scopedSet.has(t), name).toBe(false);
      continue;
    }
    expect(scopedSet.has(t), `${name} references accounts but is not in accountTables`).toBe(true);
  }
  // Each scoped table references accounts through account_id, the column scoped() filters by,
  // and names another account only where it says so.
  for (const t of scopedSet) {
    const name = getTableName(t);
    expect(accountReferences(t), name).toEqual(["account_id", ...(otherAccounts[name] ?? [])]);
  }
  for (const name of Object.keys(unscoped)) {
    expect(
      referencing.map((t) => getTableName(t)),
      name,
    ).toContain(name);
  }
  expect(Object.keys(rows).sort()).toEqual(Object.keys(schema.accountTables).sort());
});

// Tables whose rows have their own id; preferences and budgets are one row
// per account, platform links one per account, platform and host, and
// usage counters one per account, kind and day.
type Keyed = "preferences" | "budgets" | "platformLinks" | "usageCounters" | "liveEvents";
const KEYED: readonly string[] = [
  "preferences",
  "budgets",
  "platformLinks",
  "usageCounters",
  "liveEvents",
];
const withIds = (Object.keys(rows) as (keyof typeof rows)[]).filter(
  (n): n is Exclude<keyof typeof rows, Keyed> => !KEYED.includes(n),
);

describe.each(withIds)("%s", (name) => {
  beforeEach(async () => {
    // A finding needs a review to belong to (foreign key).
    if (["findings", "reviewWalkthroughs", "reviewChatMessages"].includes(name)) {
      await db
        .insert(schema.reviews)
        .values({ id: "review-of-a", accountId: A, runId: "r", repoHash: "h", source: "local" });
    }
    if (
      [
        "reviewJobs",
        "replyJobs",
        "closedPulls",
        "pullFlows",
        "pullReviews",
        "pullPaths",
        "reviewRequests",
        "mergeChecks",
        "mergeCheckRuns",
        "generateJobs",
      ].includes(name)
    ) {
      await db
        .insert(schema.reviewRepos)
        .values({ ...rows.reviewRepos("review-repo-of-a"), accountId: A });
    }
    if (["liveGrants", "liveComments"].includes(name)) {
      await db.insert(schema.liveRuns).values({ ...rows.liveRuns("live-run-of-a"), accountId: A });
    }
    if (name === "graphBuilds") {
      await db
        .insert(schema.graphRepos)
        .values({ ...rows.graphRepos("graph-repo-of-a"), accountId: A });
    }
  });

  it("one account cannot read, change or delete another's rows", async () => {
    const a = scoped(db, A);
    const b = scoped(db, B);
    await a.insert(name, rows[name]("row-1") as never);

    expect(await a.list(name)).toHaveLength(1);
    expect(await b.list(name)).toEqual([]);
    expect(await b.get(name, "row-1")).toBeUndefined();
    expect(await b.update(name, "row-1", changes[name] as never)).toBe(false);
    expect(await b.remove(name, "row-1")).toBe(false);
    expect(await a.get(name, "row-1")).toMatchObject({ id: "row-1", accountId: A });
    expect(await a.get(name, "row-1")).not.toMatchObject(changes[name]);
    expect(await a.update(name, "row-1", changes[name] as never)).toBe(true);
    expect(await a.get(name, "row-1")).toMatchObject(changes[name]);
    expect(await b.countSince(name, new Date(0))).toBe(0);
    expect(await a.countSince(name, new Date(0))).toBe(1);
  });

  it("an insert cannot name another account", async () => {
    const b = scoped(db, B);
    await b.insert(name, { ...(rows[name]("row-2") as object), accountId: A } as never);
    expect(await scoped(db, A).list(name)).toEqual([]);
    expect(await b.get(name, "row-2")).toMatchObject({ accountId: B });
  });

  it("an update cannot move a row to another account", async () => {
    const a = scoped(db, A);
    await a.insert(name, rows[name]("row-3") as never);
    await a.update(name, "row-3", { ...changes[name], accountId: B } as never);
    expect(await a.get(name, "row-3")).toMatchObject({ accountId: A });
    expect(await scoped(db, B).list(name)).toEqual([]);
  });
});

describe("budgets, one row per account", () => {
  it("one account cannot read, change or delete another's row", async () => {
    const a = scoped(db, A);
    const b = scoped(db, B);
    await a.batch((w) => [w.upsert("budgets", { dailyCalls: 5 }, ["accountId"])]);
    expect(await b.findOne("budgets", {})).toBeUndefined();
    expect(await b.removeWhere("budgets", {})).toBe(0);
    await b.batch((w) => [w.upsert("budgets", changes.budgets, ["accountId"])]);
    expect(await a.findOne("budgets", {})).toMatchObject({ accountId: A, dailyCalls: 5 });
    expect(await b.findOne("budgets", {})).toMatchObject({ accountId: B, dailyCalls: 7 });
  });
});

describe("preferences, one row per account", () => {
  it("one account cannot read, change or delete another's row", async () => {
    const a = scoped(db, A);
    const b = scoped(db, B);
    expect(await a.insert("preferences", rows.preferences("ignored") as never)).toBe(A);
    expect(await a.findOne("preferences", {})).toMatchObject({ accountId: A });
    expect(await b.findOne("preferences", {})).toBeUndefined();
    expect(await b.count("preferences")).toBe(0);
    expect(await b.removeWhere("preferences", {})).toBe(0);
    await b.batch((w) => [w.upsert("preferences", changes.preferences, ["accountId"])]);
    expect(await a.findOne("preferences", {})).not.toMatchObject(changes.preferences);
    expect(await b.findOne("preferences", {})).toMatchObject({
      accountId: B,
      ...changes.preferences,
    });
    await a.batch((w) => [w.upsert("preferences", changes.preferences, ["accountId"])]);
    expect(await a.count("preferences")).toBe(1);
    expect(await a.findOne("preferences", {})).toMatchObject(changes.preferences);
  });

  it("an insert cannot name another account", async () => {
    const b = scoped(db, B);
    await b.insert("preferences", { ...rows.preferences("x"), accountId: A } as never);
    expect(await scoped(db, A).findOne("preferences", {})).toBeUndefined();
    expect(await b.findOne("preferences", {})).toMatchObject({ accountId: B });
  });
});

describe("usage counters, one row per account, kind and day", () => {
  it("one account cannot read, count or delete another's, and counts only its own", async () => {
    const a = scoped(db, A);
    const b = scoped(db, B);
    await a.insert("usageCounters", rows.usageCounters("2026-10-09"));
    expect(await a.list("usageCounters")).toHaveLength(1);
    expect(await b.list("usageCounters")).toEqual([]);
    expect(await b.count("usageCounters")).toBe(0);
    expect(await b.removeWhere("usageCounters", {})).toBe(0);
    const now = new Date("2026-10-09T12:00:00Z");
    expect(await b.take("uploads", 1, now)).toBe(true);
    expect(await b.take("uploads", 1, now)).toBe(false);
    expect(await a.findOne("usageCounters", { day: "2026-10-09" })).toMatchObject({ n: 1 });
    expect(await a.take("uploads", 2, now)).toBe(true);
    expect(await a.findOne("usageCounters", { day: "2026-10-09" })).toMatchObject({ n: 2 });
    expect(await b.findOne("usageCounters", { day: "2026-10-09" })).toMatchObject({ n: 1 });
  });

  it("an insert cannot name another account", async () => {
    const b = scoped(db, B);
    await b.insert("usageCounters", { ...rows.usageCounters("2026-10-09"), accountId: A } as never);
    expect(await scoped(db, A).list("usageCounters")).toEqual([]);
    expect(await b.findOne("usageCounters", {})).toMatchObject({ accountId: B });
  });
});

describe("live events, one row per run and seq", () => {
  beforeEach(async () => {
    await db.insert(schema.liveRuns).values({ ...rows.liveRuns("live-run-of-a"), accountId: A });
  });

  it("one account cannot read, count or delete another's", async () => {
    const a = scoped(db, A);
    const b = scoped(db, B);
    await a.insert("liveEvents", rows.liveEvents("1"));
    expect(await a.list("liveEvents")).toHaveLength(1);
    expect(await b.list("liveEvents")).toEqual([]);
    expect(await b.live.eventsAfter("live-run-of-a", 0, 10)).toEqual([]);
    expect(await b.removeWhere("liveEvents", {})).toBe(0);
    expect(await a.live.eventsAfter("live-run-of-a", 0, 10)).toHaveLength(1);
  });
});
