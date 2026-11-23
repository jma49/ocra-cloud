import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import type { StackMergeAnswer } from "../src/shared/index.js";
import { REQUEST_CALLS, sweepStackMerges } from "../src/stack-merge/advance.js";
import { db, JSON_TYPE, resetDb, signIn } from "./helpers.js";
import { signInWithGithub } from "./platform-fakes.js";
import { github, heads, layer, merges, REPO, ref, runner, sha, start } from "./stack-fakes.js";

// What keeps a stack merge in bounds: one merge under way per pull request,
// whatever bottom a start read; a request that moves it only so many
// platform calls on; and its end told once to the channels that hear of it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const KEY = { platform: "github" as const, host: "github.com", fullName: "octo/api" };
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

const starting = (bottom: number, top: number) => ({
  ...KEY,
  bottom,
  trunk: "main",
  method: "squash" as const,
  chain: Array.from({ length: top - bottom + 1 }, (_, i) => ({
    number: bottom + i,
    head: sha(bottom + i),
  })),
  startedBy: "octo",
});

describe("one stack merge per pull request", () => {
  it("answers the merge under way to a start from a higher layer once its bottom merged", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "PENDING" }),
      layer(3, "step-2"),
    ]);
    const { a, answer, data } = await start(3);
    expect(merges(fake.sent)).toEqual([`${REPO}/pulls/1/merge`]);
    // The stack now reads from #2: a start from the page of #3 names a new bottom.
    for (const [number, read] of [
      [3, heads(2, 3)],
      [2, heads(2)],
    ] as const) {
      const res = await a.send("/api/pulls/merge-stack", {
        method: "POST",
        headers: JSON_TYPE,
        body: JSON.stringify({ ...ref, number, method: "merge", heads: read }),
      });
      expect((await res.json()) as StackMergeAnswer).toMatchObject({
        outcome: "running",
        job: { id: answer.job?.id, bottom: 1, method: "squash" },
      });
    }
    expect((await data.list("stackMerges")).map((m) => m.id)).toEqual([answer.job?.id]);
  });

  it("takes one of two starts at once whose chains share a layer, whatever bottom each read", async () => {
    const data = scoped(db, (await signIn(1, "octo")).account.id);
    const now = new Date();
    // One read the stack before its bottom merged on the platform, the other after.
    const both = await Promise.all([
      data.stackMerges.start(starting(1, 3), now),
      data.stackMerges.start(starting(2, 4), now),
    ]);
    expect(both.map((s) => s?.started).sort()).toEqual([false, true]);
    expect(both[0]?.merge.id).toBe(both[1]?.merge.id);
    expect(await data.count("stackMerges")).toBe(1);
    const held = (await data.list("stackMergeLayers")).map((l) => [l.mergeId, l.number]);
    const won = both[0]?.merge;
    expect(held.sort()).toEqual(won?.chain.map((l) => [won.id, l.number]));
  });

  it("refuses in the database a merge whose layer another holds, and frees the layers when it ends", async () => {
    const data = scoped(db, (await signIn(1, "octo")).account.id);
    const first = await data.stackMerges.start(starting(1, 2), new Date());
    expect(first?.started).toBe(true);
    // Past the start's own read: the layer's row is what refuses.
    await expect(
      data.insert("stackMergeLayers", {
        mergeId: first?.merge.id ?? "",
        ...KEY,
        number: 2,
      }),
    ).rejects.toThrow();
    expect(await data.stackMerges.cancel(first?.merge.id ?? "", new Date())).toBe(true);
    expect(await data.count("stackMergeLayers")).toBe(0);
    const next = await data.stackMerges.start(starting(2, 3), new Date());
    expect(next).toMatchObject({ started: true, merge: { bottom: 2, state: "waiting" } });
    // A merge that ended is replaced by the next of its bottom.
    const claim = await data.stackMerges.claim(next?.merge.id ?? "", new Date());
    await data.stackMerges.finish(next?.merge.id ?? "", claim as Date, "merged", null, new Date());
    expect(await data.count("stackMergeLayers")).toBe(0);
    const again = await data.stackMerges.start(starting(2, 3), new Date());
    expect(again?.started).toBe(true);
    expect((await data.list("stackMerges")).map((m) => m.bottom).sort()).toEqual([1, 2]);
  });
});

describe("a tall stack whose layers can all merge", () => {
  const TALL = 12;
  const tall = () =>
    Array.from({ length: TALL }, (_, i) => layer(i + 1, i === 0 ? "main" : `step-${i}`));

  it("is moved only so many platform calls on by the request, answered in progress, and finished by the sweep", async () => {
    const fake = github(tall());
    const a = await signInWithGithub();
    const before = fake.count.calls;
    const { answer, data } = await start(TALL, a);
    expect(answer.outcome).toBe("started");
    expect(answer.job).toMatchObject({ state: "waiting", reason: "waiting_platform" });
    const step = answer.job?.step ?? 0;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(TALL);
    expect(merges(fake.sent)).toHaveLength(step);
    // The start's own reads and the run's, well under a Worker request's 50.
    expect(fake.count.calls - before).toBeLessThanOrEqual(REQUEST_CALLS + 5);

    let at = Date.now();
    for (let i = 0; i < TALL; i++) {
      at += 2 * 60_000;
      await sweepStackMerges(runner(), new Date(at));
    }
    expect(await data.stackMerges.byId(answer.job?.id ?? "")).toMatchObject({
      state: "merged",
      step: TALL,
    });
    expect(merges(fake.sent)).toHaveLength(TALL);
  });

  it("is moved no further by a status read than a request may go", async () => {
    const fake = github(tall());
    const { a, answer } = await start(TALL);
    const before = fake.count.calls;
    vi.useFakeTimers({ now: Date.now() + 20_000, toFake: ["Date"] });
    try {
      const res = await a.send(
        `/api/pulls/merge-stack?platform=github&repo=octo/api&number=${TALL}`,
      );
      const read = (await res.json()) as StackMergeAnswer;
      expect(res.status).toBe(200);
      expect(read.job?.step).toBeGreaterThan(answer.job?.step ?? 0);
      expect(fake.count.calls - before).toBeLessThanOrEqual(REQUEST_CALLS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stack merge that ends", () => {
  async function hearing() {
    const a = await signInWithGithub();
    const added = await a.send("/api/notifications/channels", {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({
        kind: "slack",
        url: SLACK,
        name: "team",
        when: "blocking",
        events: ["stack_merge"],
      }),
    });
    expect(added.ok).toBe(true);
    return a;
  }

  it("tells the channels that hear about stack merges that it merged, once", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "PENDING" }),
    ]);
    const { data } = await start(2, await hearing());
    expect(fake.posted).toEqual([]);
    Object.assign(fake.pulls.get(2) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    const later = new Date(Date.now() + 5 * 60_000);
    // As the Worker's cron runs it: no outbox given, its links under PUBLIC_URL.
    const cron = { ...runner(), env: { ...env, PUBLIC_URL: "https://console.test" } };
    await Promise.all([sweepStackMerges(cron, later), sweepStackMerges(cron, later)]);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toContain("https://console.test/");
    expect(fake.posted[0]).toContain("Your stack merge finished: 2 pull requests merged");
    expect(fake.posted[0]).toContain("octo/api#2");
    const [job] = await data.list("stackMerges");
    expect((await data.list("notifySends")).map((s) => s.eventKey)).toEqual([
      `stack-merge:${job?.id}:merged`,
    ]);
  });

  it("tells them the layer it stopped at and why, and nothing of a cancel", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "FAILURE" }),
      layer(3, "step-2"),
    ]);
    const a = await hearing();
    const { answer } = await start(3, a);
    expect(answer.job).toMatchObject({ state: "failed", reason: "checks_failed" });
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toContain("Your stack merge stopped at #2: its checks failed");

    vi.restoreAllMocks();
    await resetDb();
    const quiet = github([
      layer(1, "main", { mergeState: "BLOCKED", checks: "PENDING" }),
      layer(2, "step-1"),
    ]);
    const b = await hearing();
    await start(2, b);
    await b.send("/api/pulls/merge-stack", {
      method: "DELETE",
      headers: JSON_TYPE,
      body: JSON.stringify({ ...ref, number: 1 }),
    });
    expect(quiet.posted).toEqual([]);
  });

  it("tells nobody without a channel that hears about stack merges", async () => {
    const fake = github([layer(1, "main")]);
    const { answer } = await start(1);
    expect(answer.job).toMatchObject({ state: "merged" });
    expect(fake.posted).toEqual([]);
  });
});
