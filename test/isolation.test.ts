import { env } from "cloudflare:workers";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";

const db = drizzle(env.DB);
const A = "acct-a";
const B = "acct-b";

// One row per account-scoped table. A table added to the schema without a
// case here fails the first test.
const rows = {
  sessions: (id: string) => ({
    id,
    tokenHash: `hash-${id}`,
    kind: "cli" as const,
    expiresAt: new Date(Date.now() + 86_400_000),
  }),
  providerKeys: (id: string) => ({
    id,
    provider: "openrouter",
    wrappedKey: "w",
    ciphertext: "c",
    last4: "abcd",
  }),
  reviews: (id: string) => ({ id, repoHash: "r" }),
  auditEvents: (id: string) => ({ id, kind: "key.used", detail: { model: "m" } }),
  gatewayCalls: (id: string) => ({
    id,
    provider: "openrouter",
    path: "/v1/chat/completions",
    status: 200,
  }),
} satisfies { [N in keyof typeof schema.accountTables]: (id: string) => unknown };

// A change to one column of each table's row.
const changes = {
  sessions: { label: "changed" },
  providerKeys: { last4: "zzzz" },
  reviews: { findings: 9 },
  auditEvents: { kind: "changed" },
  gatewayCalls: { status: 500 },
} satisfies { [N in keyof typeof rows]: Record<string, unknown> };

// Storage persists across tests in a file; deleting the accounts cascades.
beforeEach(async () => {
  await db.delete(schema.accounts);
  await db.insert(schema.accounts).values([
    { id: A, githubId: 1, login: "a" },
    { id: B, githubId: 2, login: "b" },
  ]);
});

it("covers every table that has an account column", () => {
  const scopedTables = Object.values(schema)
    .filter((t) => typeof t === "object" && t !== null && "accountId" in getTableColumnsSafe(t))
    .map((t) => t as object);
  expect(new Set(scopedTables)).toEqual(new Set(Object.values(schema.accountTables)));
  expect(Object.keys(rows).sort()).toEqual(Object.keys(schema.accountTables).sort());
});

describe.each(Object.keys(rows) as (keyof typeof rows)[])("%s", (name) => {
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

function getTableColumnsSafe(t: object): Record<string, unknown> {
  try {
    return getTableColumns(t as never) ?? {};
  } catch {
    return {};
  }
}
