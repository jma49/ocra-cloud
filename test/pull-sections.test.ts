import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullItem, PullSection, PullView } from "../src/shared/index.js";
import { HASH } from "./finding-uploads.js";
import { call, resetDb, signInCli } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

type Grouped = { platforms: { pulls: PullItem[] }[]; sections: PullSection[] };

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const node = (n: number, over: Record<string, unknown> = {}) => ({
  id: `PR_${n}`,
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  createdAt: daysAgo(30),
  updatedAt: daysAgo(1),
  additions: 1,
  deletions: 1,
  reviewDecision: null,
  author: { login: "ada" },
  repository: { nameWithOwner: "octo/api" },
  labels: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});

// 1: asks my review, labelled; 2: mine, waiting, failing CI, a week old;
// 3: mine, approved; 4: mine, merged.
function inbox() {
  githubFake({
    extra: (req) =>
      req.url === "https://api.github.com/graphql"
        ? Response.json({
            data: {
              review: {
                issueCount: 1,
                nodes: [node(1, { labels: { nodes: [{ name: "Security" }, null] } })],
              },
              authored: {
                issueCount: 2,
                nodes: [
                  node(2, {
                    author: { login: "octo" },
                    reviewDecision: "REVIEW_REQUIRED",
                    updatedAt: daysAgo(8),
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
                  }),
                  node(3, { author: { login: "octo" }, reviewDecision: "APPROVED" }),
                ],
              },
              assigned: { issueCount: 0, nodes: [] },
              merged: {
                issueCount: 1,
                nodes: [
                  node(4, { author: { login: "octo" }, state: "MERGED", mergedAt: daysAgo(1) }),
                ],
              },
            },
          })
        : undefined,
  });
}

let run = 0;
async function review(githubId: number, number: number, verdict: string | null, complete = true) {
  const cli = await signInCli(githubId, "octo");
  run += 1;
  const res = await call("/api/reviews", {
    method: "POST",
    auth: cli.auth,
    json: {
      runId: `20261004T0600${String(run).padStart(2, "0")}Z-0a0b0c`,
      repoHash: HASH,
      source: "github",
      verdict,
      complete,
      findings: { critical: 0, warning: 0, suggestion: 0 },
      pullRequest: { repository: "https://github.com/octo/api", number, headSha: "9".repeat(40) },
    },
  });
  expect(res.ok).toBe(true);
}

const numbers = (answer: Grouped, name: string) => {
  const byId = new Map(answer.platforms.flatMap((p) => p.pulls).map((p) => [p.id, p.number]));
  return answer.sections
    .find((s) => s.view.name === name)
    ?.pulls.map((r) => byId.get(r.id))
    .sort();
};

describe("the inbox grouped by views", () => {
  it("answers the defaults while the account has no views, over the one listing", async () => {
    inbox();
    const a = await signInWithGithub();
    const grouped = (await (await a.send("/api/platforms/pulls?group=views")).json()) as Grouped;
    expect(grouped.sections.map((s) => [s.view.id, s.view.name])).toEqual([
      ["default:0", "Needs my review"],
      ["default:1", "My open PRs"],
      ["default:2", "Waiting on others"],
      ["default:3", "Recently merged"],
    ]);
    expect(numbers(grouped, "Needs my review")).toEqual([1]);
    expect(numbers(grouped, "My open PRs")).toEqual([2, 3]);
    expect(numbers(grouped, "Waiting on others")).toEqual([2]);
    expect(numbers(grouped, "Recently merged")).toEqual([4]);
    expect(grouped.platforms[0]?.pulls.find((p) => p.number === 1)?.labels).toEqual(["Security"]);

    const plain = (await (await a.send("/api/platforms/pulls")).json()) as Record<string, unknown>;
    expect(plain.sections).toBeUndefined();
    expect((await a.send("/api/platforms/pulls?group=repos")).status).toBe(400);
  });

  it("evaluates each visible view's filters, the account's own verdicts included", async () => {
    inbox();
    const a = await signInWithGithub();
    await review(42, 1, "approved");
    // The newer review of the same pull is the one that counts.
    await new Promise((r) => setTimeout(r, 5));
    await review(42, 1, "significant_concerns");
    await review(42, 3, "minor_issues");
    // A newer review that left files unreviewed takes the pass away.
    await review(42, 4, "approved");
    await new Promise((r) => setTimeout(r, 5));
    await review(42, 4, "approved", false);
    // Another account's review of pull 2 says nothing of this account's inbox.
    await review(7, 2, "significant_concerns");
    const add = async (name: string, filters: unknown) =>
      (await (
        await a.send("/api/pull-views", { method: "POST", body: JSON.stringify({ name, filters }) })
      ).json()) as PullView;
    await add("Blocked", { verdicts: ["blocking"] });
    await add("Unreviewed", { verdicts: ["unreviewed"] });
    await add("Security", { labels: ["security"] });
    await add("Fresh mine", { authoredBy: "me", updatedWithinDays: 7 });
    await add("Red", { checks: ["failing"], reviews: ["required"] });
    const hidden = await add("Hidden", {});
    await a.send(`/api/pull-views/${hidden.id}`, {
      method: "PUT",
      body: JSON.stringify({ hidden: true }),
    });

    const grouped = (await (await a.send("/api/platforms/pulls?group=views")).json()) as Grouped;
    expect(grouped.sections.map((s) => s.view.name)).toEqual([
      "Blocked",
      "Unreviewed",
      "Security",
      "Fresh mine",
      "Red",
    ]);
    expect(numbers(grouped, "Blocked")).toEqual([1]);
    expect(numbers(grouped, "Unreviewed")).toEqual([2, 4]);
    expect(numbers(grouped, "Security")).toEqual([1]);
    expect(numbers(grouped, "Fresh mine")).toEqual([3, 4]);
    expect(numbers(grouped, "Red")).toEqual([2]);
    const verdicts = grouped.platforms[0]?.pulls.map((p) => [p.number, p.verdict]);
    expect(verdicts?.sort()).toEqual([
      [1, "blocking"],
      [2, null],
      [3, "not_blocking"],
      [4, null],
    ]);
  });
});
