import { count, eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { githubIdentity, githubIdOf, upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { db, resetDb } from "./helpers.js";

// An account is found by the identity it signs in with; the same person at
// two providers is two accounts.

beforeEach(resetDb);

const accountsNow = async () => (await db.select({ n: count() }).from(schema.accounts).get())?.n;

it("makes one account for two first sign-ins racing", async () => {
  const both = await Promise.all([
    upsertAccount(db, githubIdentity(7), "octo"),
    upsertAccount(db, githubIdentity(7), "octo"),
  ]);
  expect(both[0].id).toBe(both[1].id);
  expect(await accountsNow()).toBe(1);
});

it("keeps a provider's subjects apart from another provider's", async () => {
  const github = await upsertAccount(db, githubIdentity(7), "octo");
  const sso = await upsertAccount(db, { provider: "oidc", subject: "7" }, "octo");
  expect(sso.id).not.toBe(github.id);
  expect(await githubIdOf(db, github.id)).toBe(7);
  expect(await githubIdOf(db, sso.id)).toBeNull();
});

it("goes with its account", async () => {
  const account = await upsertAccount(db, githubIdentity(7), "octo");
  await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
  expect(await db.select().from(schema.identities).all()).toEqual([]);
});
