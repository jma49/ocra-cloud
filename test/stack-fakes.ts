import { env } from "cloudflare:workers";
import { expect } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { platformsOf } from "../src/platforms/registry.js";
import type { StackMergeAnswer } from "../src/shared/index.js";
import { db, ORIGIN } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// What the stack merge tests share: a GitHub repository of stacked pull
// requests, and a merge started from its page.

const API = "https://api.github.com";
export const REPO = `${API}/repos/octo/api`;
export const sha = (n: number, v = 0) => `${n}${v}`.repeat(40).slice(0, 40);
/** The squash commit a merged pull request landed as. */
export const mergeOf = (n: number) => `f${n}`.repeat(40).slice(0, 40);

export type Fake = {
  number: number;
  head: string;
  base: string;
  sha: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeState: string;
  checks: "SUCCESS" | "PENDING" | "FAILURE" | null;
  /** The head's check runs, each with whether the base branch requires it. */
  runs?: { name: string; conclusion: "SUCCESS" | "FAILURE" | null; required: boolean }[];
};
export type Sent = { method: string; url: string; body: unknown };

const rollup = (p: Fake) => ({
  state: p.checks,
  ...(p.runs && {
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: p.runs.map((r) => ({
        __typename: "CheckRun",
        name: r.name,
        status: r.conclusion ? "COMPLETED" : "IN_PROGRESS",
        conclusion: r.conclusion,
        isRequired: r.required,
      })),
    },
  }),
});

/** A GitHub repository whose pull requests move as the writes sent to it say. */
export function github(pulls: Fake[], options: { refuseRetarget?: boolean } = {}) {
  const sent: Sent[] = [];
  /** What a chat channel was told, and how many calls the platform got. */
  const posted: string[] = [];
  const count = { calls: 0 };
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
    mergeCommit: p.state === "MERGED" ? { oid: mergeOf(p.number) } : null,
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? rollup(p) : null } }] },
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
      if (url.origin === "https://hooks.slack.com") {
        posted.push(((await req.json()) as { text: string }).text);
        return new Response("ok");
      }
      if (url.origin === API && url.pathname !== "/user") count.calls++;
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
      const comment = path.match(
        /^https:\/\/api\.github\.com\/repos\/octo\/api\/issues\/(\d+)\/comments$/,
      );
      if (comment && req.method === "POST") {
        sent.push({ method: req.method, url: path, body: await req.json() });
        return Response.json({ id: 1 }, { status: 201 });
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
  return { sent, pulls: byNumber, posted, count };
}

export const layer = (number: number, base: string, extra: Partial<Fake> = {}): Fake => ({
  number,
  head: `step-${number}`,
  base,
  sha: sha(number),
  state: "OPEN",
  mergeState: "CLEAN",
  checks: "SUCCESS",
  ...extra,
});

export const stack = () => [layer(1, "main"), layer(2, "step-1"), layer(3, "step-2")];

export const ref = { platform: "github", repo: "octo/api" };
export const heads = (...ns: number[]) => ns.map((n) => ({ number: n, head: sha(n) }));
export const runner = () => ({ db, env, platforms: platformsOf(env, ORIGIN) });

type Session = Awaited<ReturnType<typeof signInWithGithub>>;

export async function start(top: number, session?: Session) {
  const a = session ?? (await signInWithGithub());
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
export async function enroll(data: ReturnType<typeof scoped>) {
  await data.insert("reviewRepos", { ...rows.reviewRepos("r"), fullName: "octo/api" });
  const repo = await data.findOne("reviewRepos", { id: "r" });
  if (!repo) throw new Error("not enrolled");
  return repo;
}

export const merges = (sent: Sent[]) =>
  sent.filter((s) => s.url.endsWith("/merge")).map((s) => s.url);
