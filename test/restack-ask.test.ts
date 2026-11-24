import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRestackAnswer, PullRestackView } from "../src/shared/index.js";
import { assignRestack, settleRestack } from "../src/stack-merge/restack-work.js";
import { resetDb } from "./helpers.js";
import { ask, history, type Session, setUp, turn } from "./restack-fakes.js";
import { github, layer, runner, sha } from "./stack-fakes.js";

// A restack asked for on a pull request's page: queued only where the
// repository turned restacks on and the heads are the ones the page read,
// once per pull request at a time, and again after the last one ended.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const PULL = "platform=github&repo=octo%2Fapi&number=2";

async function read(a: Session): Promise<PullRestackView> {
  const res = await ask(a, `/api/pulls/restack?${PULL}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PullRestackView;
}

const request = (a: Session, heads: { head: string; parentHead: string }) =>
  ask(a, "/api/pulls/restack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "github", repo: "octo/api", number: 2, ...heads }),
  });

const HEADS = { head: sha(2), parentHead: sha(1) };
const source = () => ({
  ...runner(),
  bots: { forRepo: async () => ({ token: "ghs_bot", login: "ocra-review[bot]" }) },
});

describe("a restack asked for on the pull request's page", () => {
  async function stacked() {
    github([layer(1, "main"), layer(2, "step-1"), layer(3, "step-2")]);
    return setUp();
  }

  it("is not offered, and not queued, until the repository turns restacks on", async () => {
    const { a } = await stacked();
    expect(await read(a)).toEqual({ offered: false, job: null });
    expect((await request(a, HEADS)).status).toBe(404);
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues the layer onto the head of the one below it, for a run that finds what to drop", async () => {
    const { a } = await stacked();
    await turn(a, true);
    const res = await request(a, HEADS);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as PullRestackAnswer;
    expect(answer).toMatchObject({
      outcome: "queued",
      offered: true,
      job: {
        number: 2,
        parent: 1,
        branch: "step-2",
        onto: "step-1",
        from: sha(2),
        state: "queued",
      },
    });
    expect(answer.job?.askedBy).toBeTruthy();
    expect(await read(a)).toMatchObject({ offered: true, job: { id: answer.job?.id } });
    // Asked again while it waits: the one under way answers, and nothing more is queued.
    const again = (await (await request(a, HEADS)).json()) as PullRestackAnswer;
    expect(again).toMatchObject({ outcome: "running", job: { id: answer.job?.id } });
    expect((await history(a)).jobs).toHaveLength(1);
    expect(await assignRestack(source())).toMatchObject({
      restack: {
        branch: "step-2",
        head: sha(2),
        onto: { branch: "step-1", commit: sha(1) },
        fork: true,
      },
    });
  });

  it("queues nothing when a head moved since the page read it", async () => {
    const { a } = await stacked();
    await turn(a, true);
    for (const heads of [
      { head: sha(2, 1), parentHead: sha(1) },
      { head: sha(2), parentHead: sha(1, 1) },
    ]) {
      const answer = (await (await request(a, heads)).json()) as PullRestackAnswer;
      expect(answer).toMatchObject({ outcome: "stack_changed", job: null });
    }
    expect((await history(a)).jobs).toEqual([]);
  });

  it("can be asked again once the last one ended", async () => {
    const { a } = await stacked();
    await turn(a, true);
    await request(a, HEADS);
    const work = await assignRestack(source());
    if (!work || work === "refused") throw new Error("no restack");
    await settleRestack(source(), work, { outcome: "lease_lost" }, new Date());
    expect((await read(a)).job).toMatchObject({ state: "done", outcome: "lease_lost" });
    const answer = (await (await request(a, HEADS)).json()) as PullRestackAnswer;
    expect(answer).toMatchObject({ outcome: "queued", job: { state: "queued", outcome: null } });
    expect((await history(a)).jobs).toHaveLength(1);
  });

  it("is not for the stack's bottom, which is stacked on nothing", async () => {
    const { a } = await stacked();
    await turn(a, true);
    const res = await ask(a, "/api/pulls/restack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "github", repo: "octo/api", number: 1, ...HEADS }),
    });
    expect(res.status).toBe(404);
  });
});
