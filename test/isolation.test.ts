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
} satisfies { [N in keyof typeof rows]: Record<string, unknown> };

// Storage persists across tests in a file; deleting the accounts cascades.
beforeEach(async () => {
  await db.delete(schema.accounts);
  await db.insert(schema.accounts).values([
    { id: A, githubId: 1, login: "a" },
    { id: B, githubId: 2, login: "b" },
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
  // Each scoped table references accounts through account_id, the column scoped() filters by.
  for (const t of scopedSet) {
    expect(accountReferences(t), getTableName(t)).toEqual(["account_id"]);
  }
  for (const name of Object.keys(unscoped)) {
    expect(
      referencing.map((t) => getTableName(t)),
      name,
    ).toContain(name);
  }
  expect(Object.keys(rows).sort()).toEqual(Object.keys(schema.accountTables).sort());
});

describe.each(Object.keys(rows) as (keyof typeof rows)[])("%s", (name) => {
  beforeEach(async () => {
    // A finding needs a review to belong to (foreign key).
    if (name === "findings") {
      await db
        .insert(schema.reviews)
        .values({ id: "review-of-a", accountId: A, runId: "r", repoHash: "h", source: "local" });
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
