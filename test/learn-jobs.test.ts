import { beforeEach, describe, expect, it } from "vitest";
import { claimLearn } from "../src/db/learn-jobs.js";
import { scoped } from "../src/db/scoped.js";
import { db, resetDb, signIn } from "./helpers.js";

// A pull request's declined findings wait in one row: each answer queues
// it again, one that arrives during its run makes the run's end the next
// run's start, and one runner claims it.

beforeEach(resetDb);

const LEASE = 60 * 60_000;
const CALLS = 1000;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 2, 10, minutes));

async function enrolled() {
  const me = await signIn(42, "mona");
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "Octo/API",
  });
  return { data, repoId, jobs: data.learning };
}

describe("learn jobs", () => {
  it("keeps one row per pull request, due at the newest answer's time", async () => {
    const { data, repoId, jobs } = await enrolled();
    await jobs.queue(repoId, 7, at(5));
    await jobs.queue(repoId, 7, at(9));
    await jobs.queue(repoId, 8, at(6));
    expect(await data.count("learnJobs")).toBe(2);
    expect(await claimLearn(db, at(5), LEASE, CALLS)).toBeUndefined();
    expect(await claimLearn(db, at(6), LEASE, CALLS)).toMatchObject({ number: 8, attempts: 1 });
    expect(await claimLearn(db, at(8), LEASE, CALLS)).toBeUndefined();
    expect(await claimLearn(db, at(9), LEASE, CALLS)).toMatchObject({ number: 7, attempts: 1 });
  });

  it("runs once more after a run during which a thread was answered", async () => {
    const { data, repoId, jobs } = await enrolled();
    await jobs.queue(repoId, 7, at(0));
    const first = await claimLearn(db, at(0), LEASE, CALLS);
    await jobs.queue(repoId, 7, at(30));
    expect(await data.list("learnJobs")).toMatchObject([
      { state: "running", again: true, attempts: 1, notBefore: at(0) },
    ]);
    await jobs.finish(first?.id ?? "", 1, at(1));
    expect(await data.list("learnJobs")).toMatchObject([
      { state: "queued", again: false, attempts: 0, notBefore: null, finishedAt: null },
    ]);
    const second = await claimLearn(db, at(1), LEASE, CALLS);
    await jobs.finish(second?.id ?? "", 1, at(2));
    expect(await data.list("learnJobs")).toMatchObject([{ state: "done", finishedAt: at(2) }]);
    expect(await claimLearn(db, at(3), LEASE, CALLS)).toBeUndefined();
  });

  it("queues a pull request that was read, or given up, again at the next answer", async () => {
    const { data, repoId, jobs } = await enrolled();
    await jobs.queue(repoId, 7, at(0));
    const claimed = await claimLearn(db, at(0), LEASE, CALLS);
    await jobs.release(claimed?.id ?? "", 1, "review_failed", null, at(1));
    expect(await data.list("learnJobs")).toMatchObject([
      { state: "failed", error: "review_failed" },
    ]);
    await jobs.queue(repoId, 7, at(10));
    expect(await data.list("learnJobs")).toMatchObject([
      { state: "queued", attempts: 0, error: null, finishedAt: null, notBefore: at(10) },
    ]);
  });

  it("lists a repository's waiting and running jobs, and those that ended lately", async () => {
    const { repoId, jobs } = await enrolled();
    await jobs.queue(repoId, 7, at(0));
    await jobs.queue(repoId, 8, at(0));
    const claimed = await claimLearn(db, at(0), LEASE, CALLS);
    await jobs.finish(claimed?.id ?? "", 1, at(1));
    const numbers = async (since: Date) =>
      (await jobs.recent(repoId, since)).map((j) => [j.number, j.state]).sort();
    expect(await numbers(at(0))).toEqual([
      [7, "done"],
      [8, "queued"],
    ]);
    expect(await numbers(at(2))).toEqual([[8, "queued"]]);
  });
});
