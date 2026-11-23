import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import worker from "../src/index.js";
import { saveToken } from "../src/platforms/links.js";
import { platformsOf } from "../src/platforms/registry.js";
import { db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// The daily reconciliation, from the hourly cron: closes and open states the
// webhooks missed are read from the platform, each repository once a UTC
// day, a few per account per run, and what a webhook recorded stands.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const API = "https://api.github.com";

type Pull = {
  number: number;
  state: "open" | "closed";
  merged?: Date;
  closed?: Date;
  updated: Date;
  draft?: boolean;
};

const githubPull = (p: Pull) => ({
  number: p.number,
  title: `Pull ${p.number}`,
  state: p.state,
  draft: p.draft ?? false,
  user: { login: "dev", id: 99 },
  created_at: new Date(p.updated.getTime() - DAY).toISOString(),
  updated_at: p.updated.toISOString(),
  closed_at: (p.closed ?? p.merged)?.toISOString() ?? null,
  merged_at: p.merged?.toISOString() ?? null,
});

/** GitHub and GitLab answering for each repository's pull requests; every list read, by repository. */
function platformsWith(pulls: Record<string, Pull[]>) {
  const reads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    const gh = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?$/);
    if (url.origin === API && gh?.[1]) {
      const list = pulls[gh[1]] ?? [];
      if (gh[2]) {
        const p = list.find((x) => x.number === Number(gh[2]));
        return p ? Response.json(githubPull(p)) : new Response("{}", { status: 404 });
      }
      reads.push(gh[1]);
      const state = url.searchParams.get("state");
      const listed = list
        .filter((p) => p.state === state)
        .sort((a, b) => b.updated.getTime() - a.updated.getTime());
      return Response.json(listed.map(githubPull));
    }
    const gl = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)\/merge_requests$/);
    if (url.origin === GITLAB && gl?.[1]) {
      const name = decodeURIComponent(gl[1]);
      reads.push(name);
      const list = pulls[name] ?? [];
      const listed =
        url.searchParams.get("state") === "opened"
          ? list.filter((p) => p.state === "open")
          : list.filter((p) => p.updated >= new Date(url.searchParams.get("updated_after") ?? 0));
      return Response.json(
        listed.map((p) => ({
          iid: p.number,
          title: `MR ${p.number}`,
          state: p.state === "open" ? "opened" : p.merged ? "merged" : "closed",
          draft: p.draft ?? false,
          author: { username: "dev", id: 5 },
          created_at: new Date(p.updated.getTime() - DAY).toISOString(),
          updated_at: p.updated.toISOString(),
          merged_at: p.merged?.toISOString() ?? null,
          closed_at: p.closed?.toISOString() ?? null,
        })),
      );
    }
    return new Response("{}", { status: 404 });
  });
  return reads;
}

async function hourly() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const [github, gitlab] = (() => {
  const all = platformsOf(env, ORIGIN);
  return [all.find((p) => p.kind === "github"), all.find((p) => p.kind === "gitlab")];
})();

/** An account linked to GitHub and GitLab, with enrolled repositories enrolled a day ago. */
async function account(n: number, repos: { name: string; platform?: "github" | "gitlab" }[]) {
  const { account } = await signIn(n, `user-${n}`);
  const data = scoped(db, account.id);
  for (const p of [github, gitlab]) {
    if (p) await saveToken(data, env, p, { access_token: `token-${n}-${p.kind}` });
  }
  for (const repo of repos) {
    const platform = repo.platform ?? "github";
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(`${account.id}-${repo.name}`),
      accountId: account.id,
      platform,
      host: platform === "github" ? "github.com" : new URL(GITLAB).host,
      fullName: repo.name,
      createdAt: new Date(Date.now() - DAY),
    });
  }
  return { id: account.id, data, repo: (name: string) => `${account.id}-${name}` };
}

describe("the daily reconciliation", () => {
  it("fills in the closes and open states the webhooks missed, and keeps theirs", async () => {
    const now = Date.now();
    const a = await account(1, [{ name: "octo/api" }]);
    const repoId = a.repo("octo/api");
    const webhookClose = new Date(now - 2 * HOUR + 5 * 60_000);
    await a.data.closedPulls.record({
      reviewRepoId: repoId,
      number: 2,
      title: "Pull 2",
      merged: false,
      openedAt: null,
      closedAt: webhookClose,
    });
    const flow = (number: number, draft: boolean) =>
      a.data.pullFlows.record({
        reviewRepoId: repoId,
        number,
        title: `Pull ${number}`,
        author: "dev",
        draft,
        size: null,
        seenAt: new Date(now - 5 * HOUR),
      });
    await flow(4, false);
    await flow(5, true);
    const merged1 = new Date(now - HOUR);
    const merged4 = new Date(now - 6 * DAY);
    platformsWith({
      "octo/api": [
        { number: 1, state: "closed", merged: merged1, updated: merged1 },
        {
          number: 2,
          state: "closed",
          closed: new Date(now - 2 * HOUR),
          updated: new Date(now - 2 * HOUR),
        },
        // Merged before it was enrolled, commented on since: not the console's.
        {
          number: 3,
          state: "closed",
          merged: new Date(now - 2 * DAY),
          updated: new Date(now - 3 * HOUR),
        },
        // Merged long ago, its webhook lost: past the listing's window, read on its own.
        { number: 4, state: "closed", merged: merged4, updated: merged4 },
        { number: 5, state: "open", draft: false, updated: new Date(now - HOUR) },
        { number: 6, state: "open", updated: new Date(now - HOUR) },
      ],
    });

    await hourly();

    const closes = await a.data.list("closedPulls");
    const byNumber = new Map(closes.map((c) => [c.number, c]));
    expect([...byNumber.keys()].sort()).toEqual([1, 2, 4]);
    expect(byNumber.get(1)).toMatchObject({ merged: true, closedAt: merged1 });
    expect(byNumber.get(2)).toMatchObject({ merged: false, closedAt: webhookClose });
    expect(byNumber.get(4)).toMatchObject({ merged: true, closedAt: merged4 });
    const flows = new Map((await a.data.list("pullFlows")).map((f) => [f.number, f]));
    expect(flows.get(5)?.draft).toBe(false);
    expect(flows.get(6)).toMatchObject({ draft: false, author: "dev", authorId: "99" });
  });

  it("reads a GitLab project's merge requests through the account's link", async () => {
    const a = await account(1, [{ name: "group/app", platform: "gitlab" }]);
    const merged = new Date(Date.now() - 3 * HOUR);
    platformsWith({
      "group/app": [{ number: 7, state: "closed", merged, updated: merged }],
    });
    await hourly();
    expect(await a.data.list("closedPulls")).toMatchObject([
      { number: 7, merged: true, closedAt: merged },
    ]);
  });

  it("reads each repository once a day, however often it runs", async () => {
    await account(1, [{ name: "octo/api" }]);
    const reads = platformsWith({});
    await Promise.all([hourly(), hourly()]);
    await hourly();
    // One closed and one open listing.
    expect(reads).toEqual(["octo/api", "octo/api"]);
  });

  it("takes a few of an account's repositories per run, so another account's wait less", async () => {
    await account(
      1,
      [1, 2, 3, 4].map((i) => ({ name: `big/r${i}` })),
    );
    await account(2, [{ name: "small/one" }]);
    const reads = platformsWith({});
    await hourly();
    const read = new Set(reads);
    expect(read.has("small/one")).toBe(true);
    expect([...read].filter((r) => r.startsWith("big/"))).toHaveLength(2);
  });
});
