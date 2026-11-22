import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quantile } from "../src/cycles.js";
import { firstOther } from "../src/platforms/cycles.js";
import type { CycleView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// Pull request cycle time: merged pull requests read as the user, timed from
// opened to the first review by someone else and to merged.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2026, 10, 20) + hours * HOUR).toISOString();

describe("the first review", () => {
  it("is the earliest act by someone else before the merge", () => {
    const acts = [
      { by: "octo", at: at(1) },
      { by: "hubot", at: at(5) },
      { by: "mona", at: at(3) },
      { by: "mona", at: at(30) },
      { by: null, at: at(2) },
    ];
    expect(firstOther("octo", at(10), acts)).toBe(at(3));
    expect(firstOther("octo", at(2), acts)).toBeNull();
  });

  it("is summarised by nearest rank", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe("cycle time on GitHub", () => {
  it("times the user's merged pull requests and asks for one repository's", async () => {
    const asked: string[] = [];
    githubFake({
      extra: async (req) => {
        if (req.url !== "https://api.github.com/graphql") return undefined;
        const { variables } = (await req.json()) as { variables: { q: string } };
        asked.push(variables.q);
        return Response.json({
          data: {
            search: {
              nodes: [
                {
                  number: 7,
                  title: "Cap refunds",
                  url: "https://github.com/octo/api/pull/7",
                  createdAt: at(0),
                  mergedAt: at(10),
                  author: { login: "octo" },
                  repository: { nameWithOwner: "octo/api" },
                  reviews: {
                    nodes: [
                      { submittedAt: at(1), author: { login: "octo" } },
                      { submittedAt: at(4), author: { login: "mona" } },
                    ],
                  },
                },
                {
                  number: 8,
                  title: "Typo",
                  url: "https://github.com/octo/api/pull/8",
                  createdAt: at(0),
                  mergedAt: at(2),
                  author: { login: "octo" },
                  repository: { nameWithOwner: "octo/api" },
                  reviews: { nodes: [] },
                },
                null,
              ],
            },
          },
        });
      },
    });
    const a = await signInWithGithub();
    const mine = (await (
      await a.send("/api/insights/cycle?platform=github&days=14")
    ).json()) as CycleView;
    expect(mine.pulls.map((p) => [p.number, p.toFirstReviewMs, p.toMergeMs])).toEqual([
      [7, 4 * HOUR, 10 * HOUR],
      [8, null, 2 * HOUR],
    ]);
    expect(mine).toMatchObject({
      repo: null,
      days: 14,
      unreviewed: 1,
      toFirstReview: { median: 4 * HOUR, p90: 4 * HOUR },
      toMerge: { median: 2 * HOUR, p90: 10 * HOUR },
      capped: false,
    });
    await a.send("/api/insights/cycle?platform=github&repo=octo/api");
    expect(asked[0]).toMatch(/^is:pr is:merged author:@me merged:>=\d{4}-\d{2}-\d{2} /);
    expect(asked[1]).toMatch(/^is:pr is:merged repo:octo\/api merged:>=/);
  });

  it("refuses a repository path that is not one", async () => {
    githubFake();
    const a = await signInWithGithub();
    const res = await a.send("/api/insights/cycle?platform=github&repo=octo/../x");
    expect(res.status).toBe(404);
  });
});

describe("cycle time on GitLab", () => {
  it("takes the first note by someone else, leaving out system notes", async () => {
    const project = encodeURIComponent("group/app");
    githubFake({
      extra: (req) => {
        const url = new URL(req.url);
        if (url.origin !== GITLAB) return undefined;
        if (url.pathname === `/api/v4/projects/${project}/merge_requests`) {
          return Response.json([
            {
              id: 1,
              iid: 3,
              project_id: 9,
              title: "Retry",
              web_url: `${GITLAB}/group/app/-/merge_requests/3`,
              state: "merged",
              created_at: at(0),
              updated_at: at(9),
              merged_at: new Date(Date.now() - HOUR).toISOString(),
              author: { username: "octo" },
              references: { full: "group/app!3" },
            },
          ]);
        }
        if (url.pathname === "/api/v4/projects/9/merge_requests/3/notes") {
          return Response.json([
            { system: true, created_at: at(1), author: { username: "mona" } },
            { system: false, created_at: at(2), author: { username: "octo" } },
            { system: false, created_at: at(6), author: { username: "mona" } },
          ]);
        }
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = (await (
      await a.send("/api/insights/cycle?platform=gitlab&repo=group/app")
    ).json()) as CycleView;
    expect(view.pulls).toHaveLength(1);
    expect(view.pulls[0]).toMatchObject({
      repo: "group/app",
      number: 3,
      toFirstReviewMs: 6 * HOUR,
    });
  });
});
