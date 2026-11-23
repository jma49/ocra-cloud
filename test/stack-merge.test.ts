import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { githubFields } from "../src/inbound/fields.js";
import { gitlabSteps } from "../src/inbound/steps.js";
import { platformsOf } from "../src/platforms/registry.js";
import type { StackMergeAnswer } from "../src/shared/index.js";
import { advanceStack, sweepStackMerges } from "../src/stack-merge/advance.js";
import {
  githubMerged,
  gitlabMerged,
  moveStackMerges,
  restackOnMerge,
} from "../src/stack-merge/hooks.js";
import { db, ORIGIN, resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// A stack merge the server runs layer by layer: each layer retargeted to the
// trunk once the one below landed, merged when the platform would merge it
// (required checks, a branch that must be up to date), stopped with a
// reason on what waiting will not fix; and the pull requests stacked on one
// merged on the platform moved onto its base.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com";
const REPO = `${API}/repos/octo/api`;
const sha = (n: number, v = 0) => `${n}${v}`.repeat(40).slice(0, 40);

type Fake = {
  number: number;
  head: string;
  base: string;
  sha: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeState: string;
  checks: "SUCCESS" | "PENDING" | "FAILURE" | null;
};
type Sent = { method: string; url: string; body: unknown };

/** A GitHub repository whose pull requests move as the writes sent to it say. */
function github(pulls: Fake[], options: { refuseRetarget?: boolean } = {}) {
  const sent: Sent[] = [];
  const byNumber = new Map(pulls.map((p) => [p.number, p]));
  const node = (p: Fake) => ({
    number: p.number,
    title: `Step ${p.number}`,
    url: `https://github.com/octo/api/pull/${p.number}`,
    isDraft: false,
    headRefName: p.head,
    baseRefName: p.base,
    headRefOid: p.sha,
    isCrossRepository: false,
    reviewDecision: null,
    state: p.state,
    mergeStateStatus: p.mergeState,
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
  });
  const rest = (p: Fake) => ({
    number: p.number,
    title: `Step ${p.number}`,
    html_url: `https://github.com/octo/api/pull/${p.number}`,
    head: { ref: p.head, sha: p.sha, repo: { id: 1 } },
    base: { ref: p.base, repo: { id: 1 } },
    state: p.state === "OPEN" ? "open" : "closed",
    merged: p.state === "MERGED",
  });
  githubFake({
    extra: async (req) => {
      const url = new URL(req.url);
      const path = `${url.origin}${url.pathname}`;
      if (path === `${API}/graphql`) {
        const { query, variables } = (await req.json()) as {
          query: string;
          variables: { number?: number; after?: string | null; first?: number };
        };
        if (query.includes("pullRequests(")) {
          const open = [...byNumber.values()]
            .filter((p) => p.state === "OPEN")
            .sort((a, b) => b.number - a.number);
          const from = Number(variables.after ?? 0);
          const page = open.slice(from, from + (variables.first ?? 100));
          const end = from + page.length;
          return Response.json({
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: end < open.length, endCursor: String(end) },
                  nodes: page.map(node),
                },
              },
            },
          });
        }
        const p = byNumber.get(variables.number ?? 0);
        return Response.json({ data: { repository: { pullRequest: p ? node(p) : null } } });
      }
      if (req.method === "GET" && path === `${REPO}/pulls`) {
        const base = url.searchParams.get("base");
        const open = [...byNumber.values()].filter((p) => p.state === "OPEN" && p.base === base);
        return Response.json(open.map(rest));
      }
      const m = path.match(
        /^https:\/\/api\.github\.com\/repos\/octo\/api\/pulls\/(\d+)(\/\w[\w-]*)?$/,
      );
      const p = m ? byNumber.get(Number(m[1])) : undefined;
      if (!m || !p) return undefined;
      if (req.method === "GET" && !m[2]) return Response.json(rest(p));
      const body = (await req.json()) as Record<string, unknown>;
      sent.push({ method: req.method, url: path, body });
      if (req.method === "PATCH") {
        if (options.refuseRetarget) return new Response("{}", { status: 403 });
        p.base = String(body.base);
        return Response.json(rest(p));
      }
      if (m[2] === "/merge") {
        if (p.state !== "OPEN" || body.sha !== p.sha) return new Response("{}", { status: 405 });
        p.state = "MERGED";
        return Response.json({ merged: true });
      }
      if (m[2] === "/update-branch") {
        p.sha = sha(p.number, 1);
        p.mergeState = "BLOCKED";
        p.checks = "PENDING";
        return Response.json({}, { status: 202 });
      }
      return undefined;
    },
  });
  return { sent, pulls: byNumber };
}

const layer = (number: number, base: string, extra: Partial<Fake> = {}): Fake => ({
  number,
  head: `step-${number}`,
  base,
  sha: sha(number),
  state: "OPEN",
  mergeState: "CLEAN",
  checks: "SUCCESS",
  ...extra,
});

const stack = () => [layer(1, "main"), layer(2, "step-1"), layer(3, "step-2")];

const ref = { platform: "github", repo: "octo/api" };
const heads = (...ns: number[]) => ns.map((n) => ({ number: n, head: sha(n) }));
const runner = () => ({ db, env, platforms: platformsOf(env, ORIGIN) });

async function start(top: number) {
  const a = await signInWithGithub();
  const res = await a.send("/api/pulls/merge-stack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ref, number: top, method: "squash", heads: heads(...range(top)) }),
  });
  expect(res.status).toBe(200);
  const [account] = await db.select().from(schema.accounts);
  if (!account) throw new Error("no account");
  return { a, answer: (await res.json()) as StackMergeAnswer, data: scoped(db, account.id) };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** The repository as the account enrolled it, where its webhooks arrive. */
async function enroll(data: ReturnType<typeof scoped>) {
  await data.insert("reviewRepos", { ...rows.reviewRepos("r"), fullName: "octo/api" });
  const repo = await data.findOne("reviewRepos", { id: "r" });
  if (!repo) throw new Error("not enrolled");
  return repo;
}

const merges = (sent: Sent[]) => sent.filter((s) => s.url.endsWith("/merge")).map((s) => s.url);

describe("a stack merge under required checks", () => {
  it("merges the bottom at once, then each layer once its checks pass, all three in the end", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "PENDING" }),
      layer(3, "step-2", { mergeState: "BLOCKED", checks: "PENDING" }),
    ]);
    const { answer, data } = await start(3);
    expect(answer.outcome).toBe("started");
    expect(answer.job).toMatchObject({ step: 1, state: "waiting", reason: "waiting_checks" });
    // Retargeted onto the trunk once the one below landed.
    expect(fake.pulls.get(2)?.base).toBe("main");
    expect(fake.pulls.get(3)?.base).toBe("step-2");

    Object.assign(fake.pulls.get(2) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    const repo = await enroll(data);
    // What the webhooks say once a layer's checks finish.
    await moveStackMerges(runner(), repo, "octo/api", { head: sha(2) });
    let job = await data.stackMerges.of(
      { platform: "github", host: "github.com", fullName: "octo/api" },
      1,
    );
    expect(job).toMatchObject({ step: 2, state: "waiting", reason: "waiting_checks" });
    expect(fake.pulls.get(3)?.base).toBe("main");

    Object.assign(fake.pulls.get(3) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    await moveStackMerges(runner(), repo, "octo/api", { number: 3 });
    job = await data.stackMerges.byId(job?.id ?? "");
    expect(job).toMatchObject({ step: 3, state: "merged", reason: null });
    expect(merges(fake.sent)).toEqual([
      `${REPO}/pulls/1/merge`,
      `${REPO}/pulls/2/merge`,
      `${REPO}/pulls/3/merge`,
    ]);
    const kinds = (await data.list("auditEvents"))
      .map((e) => e.kind)
      .filter((k) => k !== "session.signed_in")
      .sort();
    expect(kinds).toEqual(["stack_merge.merged", "stack_merge.started"]);
  });

  it("brings a layer that must be up to date with the trunk up to date, then merges its new head", async () => {
    const fake = github([layer(1, "main"), layer(2, "step-1", { mergeState: "BEHIND" })]);
    const { answer, data } = await start(2);
    expect(answer.job).toMatchObject({ step: 1, state: "waiting", reason: "updating" });
    expect(fake.pulls.get(2)?.sha).toBe(sha(2, 1));
    // The new head's checks finish: its merge names the head the platform made.
    Object.assign(fake.pulls.get(2) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    const job = await data.stackMerges.byId(answer.job?.id ?? "");
    await advanceStack(
      { runner: runner(), data, platform: runner().platforms[0] as never },
      job as never,
      new Date(Date.now() + 1),
    );
    const done = await data.stackMerges.byId(answer.job?.id ?? "");
    expect(done).toMatchObject({
      state: "merged",
      chain: [heads(1)[0], { number: 2, head: sha(2, 1) }],
    });
    expect(fake.sent.find((s) => s.url === `${REPO}/pulls/2/merge`)?.body).toMatchObject({
      sha: sha(2, 1),
    });
  });

  it("stops at a failed check with the reason, and merges nothing above it", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "FAILURE" }),
      layer(3, "step-2"),
    ]);
    const { answer } = await start(3);
    expect(answer.job).toMatchObject({ step: 1, state: "failed", reason: "checks_failed" });
    expect(answer.job?.finishedAt).not.toBeNull();
    expect(merges(fake.sent)).toEqual([`${REPO}/pulls/1/merge`]);
  });

  it("stops on conflicts and on a retarget the platform refuses", async () => {
    github([layer(1, "main", { mergeState: "DIRTY" }), layer(2, "step-1")]);
    expect((await start(2)).answer.job).toMatchObject({
      step: 0,
      state: "failed",
      reason: "conflicts",
    });
    vi.restoreAllMocks();
    await resetDb();
    github(stack(), { refuseRetarget: true });
    expect((await start(2)).answer.job).toMatchObject({
      step: 1,
      state: "failed",
      reason: "refused",
    });
  });

  it("starts nothing when the stack is not the one the page read, and one merge per stack at a time", async () => {
    const fake = github([
      layer(1, "main", { mergeState: "BLOCKED", checks: "PENDING" }),
      layer(2, "step-1"),
    ]);
    const a = await signInWithGithub();
    const post = (body: unknown) =>
      a.send("/api/pulls/merge-stack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const changed = await post({ ...ref, number: 2, method: "squash", heads: heads(2) });
    expect(await changed.json()).toEqual({ outcome: "stack_changed", job: null });
    const first = (await (
      await post({ ...ref, number: 2, method: "squash", heads: heads(1, 2) })
    ).json()) as StackMergeAnswer;
    const again = (await (
      await post({ ...ref, number: 2, method: "merge", heads: heads(1, 2) })
    ).json()) as StackMergeAnswer;
    expect(first.outcome).toBe("started");
    expect(again).toMatchObject({
      outcome: "running",
      job: { id: first.job?.id, method: "squash" },
    });
    expect(fake.sent).toEqual([]);
  });

  it("is cancelled from its page, and a runner that held it then writes nothing", async () => {
    const fake = github([
      layer(1, "main"),
      layer(2, "step-1", { mergeState: "BLOCKED", checks: "PENDING" }),
    ]);
    const { a, answer, data } = await start(2);
    const job = await data.stackMerges.byId(answer.job?.id ?? "");
    const claim = await data.stackMerges.claim(job?.id ?? "", new Date(Date.now() + 1));
    const res = await a.send("/api/pulls/merge-stack", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ref, number: 1 }),
    });
    expect(((await res.json()) as StackMergeAnswer).job).toMatchObject({ state: "cancelled" });
    expect(await data.stackMerges.save(job?.id ?? "", claim as Date, { step: 2 }, new Date())).toBe(
      false,
    );
    Object.assign(fake.pulls.get(2) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    await sweepStackMerges(runner(), new Date(Date.now() + 10 * 60_000));
    expect(merges(fake.sent)).toEqual([`${REPO}/pulls/1/merge`]);
    const read = await a.send("/api/pulls/merge-stack?platform=github&repo=octo/api&number=1");
    expect(((await read.json()) as StackMergeAnswer).job).toMatchObject({
      state: "cancelled",
      step: 1,
    });
    expect(
      (await data.list("auditEvents")).map((e) => e.kind).filter((k) => k !== "session.signed_in"),
    ).toContain("stack_merge.cancelled");
  });

  it("is merged once when two sweeps run at the same time", async () => {
    const fake = github([
      layer(1, "main", { mergeState: "BLOCKED", checks: "PENDING" }),
      layer(2, "step-1"),
    ]);
    const { answer, data } = await start(2);
    expect(answer.job).toMatchObject({ step: 0, reason: "waiting_checks" });
    Object.assign(fake.pulls.get(1) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    const later = new Date(Date.now() + 5 * 60_000);
    await Promise.all([sweepStackMerges(runner(), later), sweepStackMerges(runner(), later)]);
    expect(merges(fake.sent)).toEqual([`${REPO}/pulls/1/merge`, `${REPO}/pulls/2/merge`]);
    expect(await data.stackMerges.byId(answer.job?.id ?? "")).toMatchObject({ state: "merged" });
  });

  it("is read again by its status page once the webhooks have left it waiting", async () => {
    const fake = github(
      [layer(1, "main", { mergeState: "BLOCKED", checks: "PENDING" })].concat(layer(2, "step-1")),
    );
    const { a } = await start(2);
    Object.assign(fake.pulls.get(1) ?? {}, { mergeState: "CLEAN", checks: "SUCCESS" });
    const read = async () =>
      (
        (await (
          await a.send("/api/pulls/merge-stack?platform=github&repo=octo/api&number=1")
        ).json()) as StackMergeAnswer
      ).job;
    // Just moved: answered as it stands.
    expect(await read()).toMatchObject({ step: 0, state: "waiting" });
    vi.useFakeTimers({ now: Date.now() + 20_000, toFake: ["Date"] });
    try {
      expect(await read()).toMatchObject({ state: "merged" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a pull request merged on the platform", () => {
  it("has the ones stacked on it moved onto its base, as the account that enrolled the repository", async () => {
    const fake = github([
      layer(1, "main", { state: "MERGED" }),
      layer(2, "step-1"),
      layer(4, "step-1"),
      layer(3, "step-2"),
    ]);
    await signInWithGithub();
    const [account] = await db.select().from(schema.accounts);
    const data = scoped(db, account?.id ?? "");
    const repo = await enroll(data);
    const merged = githubMerged("pull_request", {
      action: "closed",
      number: 1,
      pull_request: { merged: true, head: { ref: "step-1" }, base: { ref: "main" } },
    });
    expect(merged).toEqual({ number: 1, head: "step-1", base: "main" });
    // A merged pull request's delivery is kept with work to do; one that names no stack is not.
    const said = { number: 1 };
    expect(await gitlabSteps(db, repo, false, said, merged)).toEqual(["intents"]);
    expect(await gitlabSteps(db, repo, false, said, null)).toEqual([]);
    expect(await restackOnMerge(runner(), repo, merged as never)).toBe(2);
    expect([2, 3, 4].map((n) => fake.pulls.get(n)?.base)).toEqual(["main", "step-2", "main"]);
    expect(
      (await data.list("auditEvents")).map((e) => e.kind).filter((k) => k !== "session.signed_in"),
    ).toEqual(["stack.retargeted", "stack.retargeted"]);
  });

  it("is read from GitHub and GitLab only when it merged", () => {
    const closed = {
      action: "closed",
      number: 1,
      pull_request: { merged: false, head: { ref: "a" }, base: { ref: "b" } },
    };
    expect(githubMerged("pull_request", closed)).toBeNull();
    const mr = (action: string) => ({
      object_attributes: { iid: 4, action, source_branch: "a", target_branch: "main" },
    });
    expect(gitlabMerged("Merge Request Hook", mr("merge"))).toEqual({
      number: 4,
      head: "a",
      base: "main",
    });
    expect(gitlabMerged("Merge Request Hook", mr("close"))).toBeNull();
    // What a delivery keeps for its retries still says which branches merged.
    const merged = {
      action: "closed",
      number: 1,
      pull_request: {
        merged: true,
        head: { ref: "a", sha: sha(1) },
        base: { ref: "b" },
        body: "x",
      },
      repository: { id: 1, full_name: "octo/api" },
    };
    expect(githubMerged("pull_request", githubFields(merged))).toEqual({
      number: 1,
      head: "a",
      base: "b",
    });
  });
});

describe("finding a stack", () => {
  it("finds a bottom older than the newest 100 open pull requests", async () => {
    const newer = Array.from({ length: 150 }, (_, i) =>
      layer(1000 + i, "main", { head: `other-${i}` }),
    );
    github([layer(1, "main"), layer(2, "step-1"), ...newer]);
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/stack?platform=github&repo=octo/api&number=2");
    const view = (await res.json()) as { pulls: { number: number }[] };
    expect(view.pulls.map((p) => p.number)).toEqual([1, 2]);
  });
});
