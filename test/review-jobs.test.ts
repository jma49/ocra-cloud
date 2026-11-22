import { beforeEach, describe, expect, it } from "vitest";
import { claimJob } from "../src/db/review-jobs.js";
import { scoped } from "../src/db/scoped.js";
import { db, resetDb, signIn } from "./helpers.js";

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
});
