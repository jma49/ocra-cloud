import { beforeEach, describe, expect, it } from "vitest";
import { claimJob } from "../src/db/review-jobs.js";
import { scoped } from "../src/db/scoped.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// The auto review queue's statements on every database: one enrolling
// account per repository, one job per head, the newest head claimed.

beforeEach(resetDb);

const A = "a".repeat(40);
const B = "b".repeat(40);
const repo = (platformRepoId = "11") => ({
  platform: "github" as const,
  host: "github.com",
  platformRepoId,
  fullName: "octo/api",
});

describe("the auto review queue", () => {
  it("lets one account enroll a repository, however many try at once", async () => {
    const accounts = await Promise.all([1, 2, 3].map((n) => signIn(n, `u${n}`)));
    const ids = await Promise.all(
      accounts.map((a) => scoped(db, a.account.id).autoReview.enroll(repo(), 100)),
    );
    expect(ids.filter(Boolean)).toHaveLength(1);
  });

  it("enrolls no more than the cap, but renames an enrolled one", async () => {
    const me = scoped(db, (await signIn(1, "me")).account.id).autoReview;
    expect(await me.enroll(repo("1"), 1)).toBeDefined();
    expect(await me.enroll(repo("2"), 1)).toBeUndefined();
    expect(await me.enroll({ ...repo("1"), fullName: "octo/renamed" }, 1)).toBeDefined();
  });

  it("queues a head once and claims the pull request's newest", async () => {
    const data = scoped(db, (await signIn(1, "me")).account.id);
    const id = (await data.autoReview.enroll(repo(), 100)) ?? "";
    const now = new Date();
    expect(await data.autoReview.queue(id, 7, A, now)).toBe(true);
    expect(await data.autoReview.queue(id, 7, A, now)).toBe(false);
    expect(await data.autoReview.queue(id, 7, B, new Date(now.getTime() + 1))).toBe(true);
    const claimed = await claimJob(db, new Date(now.getTime() + 2), 60_000);
    expect(claimed).toMatchObject({ head: B, attempts: 1 });
    expect(await data.autoReview.finishJob(claimed?.id ?? "", 1, null, now)).toBe(true);
    // A stale run, one whose job was claimed again, records nothing.
    expect(await data.autoReview.finishJob(claimed?.id ?? "", 1, null, now)).toBe(false);
    const [latest] = await data.autoReview.latestJobs();
    expect(latest).toMatchObject({ head: B, state: "done" });
  });

  it("queues a head asked for once, and again as its next run only when forced", async () => {
    const data = scoped(db, (await signIn(1, "me")).account.id);
    const id = (await data.autoReview.enroll(repo(), 100)) ?? "";
    const now = new Date();
    const asked = await data.autoReview.request(id, 7, A, false, now);
    expect(asked).toMatchObject({ head: A, run: 0, state: "queued" });
    expect((await data.autoReview.request(id, 7, A, true, now))?.id).toBe(asked?.id);
    const claimed = await claimJob(db, now, 60_000);
    await data.autoReview.finishJob(claimed?.id ?? "", 1, null, now);
    expect(await data.autoReview.request(id, 7, A, false, now)).toMatchObject({ state: "done" });
    const forced = await Promise.all(
      [1, 2].map(() => data.autoReview.request(id, 7, A, true, new Date(now.getTime() + 1))),
    );
    expect(forced.map((j) => [j?.run, j?.state])).toEqual([
      [1, "queued"],
      [1, "queued"],
    ]);
    expect(await data.autoReview.latestPullJob(id, 7)).toMatchObject({ run: 1 });
  });

  it("queues nothing in a repository another account enrolled", async () => {
    const owner = scoped(db, (await signIn(1, "owner")).account.id);
    const id = (await owner.autoReview.enroll(repo(), 100)) ?? "";
    const other = scoped(db, (await signIn(2, "other")).account.id);
    expect(await other.autoReview.request(id, 7, A, true, new Date())).toBeUndefined();
    expect(await owner.autoReview.latestPullJob(id, 7)).toBeUndefined();
  });

  it("is refused on a host that runs no reviews", async () => {
    const { auth } = await signIn(1, "me");
    const res = await call("/api/pulls/review-now", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ platform: "github", repo: "octo/api", number: 7 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
