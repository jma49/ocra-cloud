import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTokens } from "../src/platforms/bot.js";
import { restackOnMerge } from "../src/stack-merge/hooks.js";
import { assignRestack, settleRestack } from "../src/stack-merge/restack-work.js";
import { resetDb } from "./helpers.js";
import { history, mergedOne, setUp, turn } from "./restack-fakes.js";
import { github, layer, REPO, runner, sha } from "./stack-fakes.js";

// A restack's job on the server: claimed with a bot that may push, ended as
// its run says, the force-push audited, the layer above queued next and a
// conflict told on the pull request.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("a restack's job", () => {
  const forRepo = vi.fn<BotTokens["forRepo"]>(async () => ({
    token: "ghs_bot",
    login: "ocra-review[bot]",
  }));
  const source = () => ({ ...runner(), bots: { forRepo } });
  beforeEach(() => forRepo.mockClear());

  async function queued() {
    const fake = github([
      layer(1, "main", { state: "MERGED" }),
      layer(2, "step-1"),
      layer(3, "step-2"),
    ]);
    const setup = await setUp();
    await turn(setup.a, true);
    const repo = await setup.data.get("reviewRepos", "r");
    await restackOnMerge(runner(), repo as never, mergedOne as never);
    return { ...setup, fake };
  }

  it("is given a bot that may push, and what to rebase", async () => {
    await queued();
    const work = await assignRestack(source());
    expect(forRepo).toHaveBeenCalledWith(expect.objectContaining({ id: "r" }), "commit");
    expect(work).toMatchObject({
      repo: { platform: "github", fullName: "octo/api" },
      bot: { token: "ghs_bot" },
      restack: {
        branch: "step-2",
        head: sha(2),
        onto: { branch: "main", commit: null },
        upstream: sha(1),
      },
    });
    expect(await assignRestack(source())).toBeUndefined();
  });

  it("is skipped once the repository turned restacks off", async () => {
    const { a } = await queued();
    await turn(a, false);
    expect(await assignRestack(source())).toBe("refused");
    expect((await history(a)).jobs).toMatchObject([
      { outcome: "skipped", reason: "switched_off", state: "done" },
    ]);
  });

  it("audits the force-push and queues the layer above onto the new head", async () => {
    const { a, data } = await queued();
    const work = await assignRestack(source());
    if (!work || work === "refused") throw new Error("no restack");
    const pushed = "e".repeat(40);
    await settleRestack(source(), work, { outcome: "restacked", head: pushed }, new Date());
    // A late second report of the same attempt changes nothing.
    await settleRestack(source(), work, { outcome: "conflict" }, new Date());
    const { jobs } = await history(a);
    expect(jobs.map((j) => [j.number, j.outcome, j.to, j.onto]).sort()).toEqual([
      [2, "restacked", pushed, "main"],
      [3, null, null, "step-2"],
    ]);
    const next = await assignRestack(source());
    expect(next).toMatchObject({
      restack: { branch: "step-3", onto: { branch: "step-2", commit: pushed }, upstream: sha(2) },
    });
    const audited = (await data.list("auditEvents")).find((e) => e.kind === "stack.force_pushed");
    expect(audited?.detail).toEqual({
      pull: "octo/api#2",
      base: "main",
      head: sha(2),
      pushed,
    });
  });

  it("tells a conflict on the pull request, as the bot, and pushes nothing", async () => {
    const { a, fake } = await queued();
    const work = await assignRestack(source());
    if (!work || work === "refused") throw new Error("no restack");
    await settleRestack(source(), work, { outcome: "conflict" }, new Date());
    const told = fake.sent.find((s) => s.url === `${REPO}/issues/2/comments`);
    expect(JSON.stringify(told?.body)).toContain("ocra stack restack");
    expect((await history(a)).jobs).toMatchObject([{ number: 2, outcome: "conflict" }]);
  });

  it("leaves a branch someone pushed to, and tries a failed clone again later", async () => {
    const { a } = await queued();
    const work = await assignRestack(source());
    if (!work || work === "refused") throw new Error("no restack");
    await settleRestack(source(), work, { failure: "clone_failed" }, new Date());
    expect((await history(a)).jobs).toMatchObject([{ state: "queued", reason: "clone_failed" }]);
    const later = () => new Date(Date.now() + 10 * 60_000);
    const again = await assignRestack({ ...source(), now: later });
    if (!again || again === "refused") throw new Error("no retry");
    await settleRestack(source(), again, { outcome: "lease_lost" }, later());
    expect((await history(a)).jobs).toMatchObject([{ state: "done", outcome: "lease_lost" }]);
  });
});
