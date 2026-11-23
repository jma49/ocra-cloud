import { beforeEach, describe, expect, it } from "vitest";
import { touchPulls } from "../src/db/pull-changes.js";
import { scoped } from "../src/db/scoped.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// When the pulls an account sees last changed, as the server hears without
// asking a platform: webhooks about its enrolled repositories' pull
// requests and its own reviews. Never another account's, never backwards.

beforeEach(resetDb);

const T0 = new Date("2026-11-21T10:00:00Z");
const T1 = new Date("2026-11-21T11:00:00Z");
const T2 = new Date("2026-11-21T12:00:00Z");

async function changedAt(auth: Record<string, string>) {
  const res = await call("/api/platforms/pulls/changed", { auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { changedAt: string | null }).changedAt;
}

describe("the inbox's change time", () => {
  it("moves with webhooks of the account's enrolled repositories only, never back", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "ada");
    await scoped(db, me.account.id).insert("reviewRepos", {
      ...rows.reviewRepos("api"),
      platformRepoId: "11",
    });
    expect(await changedAt(me.auth)).toBeNull();

    await touchPulls(db, "github", "github.com", "11", T1);
    expect(await changedAt(me.auth)).toBe(T1.toISOString());
    // A delivery that arrived late does not take it back.
    await touchPulls(db, "github", "github.com", "11", T0);
    // Another repository, or the same id on another host, is not the account's.
    await touchPulls(db, "github", "github.com", "99", T2);
    await touchPulls(db, "github", "ghe.example.com", "11", T2);
    await touchPulls(db, "gitlab", "github.com", "11", T2);
    expect(await changedAt(me.auth)).toBe(T1.toISOString());
    expect(await changedAt(other.auth)).toBeNull();
  });

  it("moves when one of the account's reviews arrives, and the listing carries it", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "ada");
    await scoped(db, other.account.id).insert("reviews", { ...rows.reviews("theirs") });
    expect(await changedAt(me.auth)).toBeNull();
    await scoped(db, me.account.id).insert("reviewRepos", {
      ...rows.reviewRepos("api"),
      platformRepoId: "11",
    });
    await touchPulls(db, "github", "github.com", "11", T0);
    await scoped(db, me.account.id).insert("reviews", { ...rows.reviews("mine"), createdAt: T2 });
    expect(await changedAt(me.auth)).toBe(T2.toISOString());

    const listing = await call("/api/platforms/pulls", { auth: me.auth });
    expect(listing.status).toBe(200);
    expect(((await listing.json()) as { changedAt: unknown }).changedAt).toBe(T2.toISOString());
  });

  it("is answered only to a signed-in user", async () => {
    expect((await call("/api/platforms/pulls/changed")).status).toBe(401);
  });
});
