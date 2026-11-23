import { z } from "zod";
import type { CallBudget } from "../calls.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformJson } from "./http.js";
import {
  RECONCILE_PER_PAGE,
  type ReconciledPull,
  type ReconcileListing,
  type RepoReconcile,
  type Spent,
  timeOf,
} from "./reconcile.js";

// GitHub's REST list of a repository's pull requests: closed ones by their
// latest change, newest first, read until one changed before `since`; open
// ones in full, up to the page cap.

/** A page of a hundred pull requests, bodies included. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const pull = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  user: z.object({ login: z.string(), id: z.number() }).nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
});

function pullOf(raw: unknown): ReconciledPull | null {
  const parsed = pull.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const merged = timeOf(p.merged_at);
  return {
    number: p.number,
    title: p.title,
    author: p.user?.login ?? null,
    authorId: p.user ? String(p.user.id) : null,
    draft: p.draft === true,
    state: p.state === "open" ? "open" : merged ? "merged" : "closed",
    openedAt: timeOf(p.created_at),
    updatedAt: timeOf(p.updated_at),
    closedAt: p.state === "open" ? null : (merged ?? timeOf(p.closed_at)),
  };
}

export function githubReconcile(host: GithubHost): RepoReconcile {
  const pullsOf = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}/pulls`;

  async function list(
    token: string,
    fullName: string,
    query: string,
    pages: number,
    calls: CallBudget,
    stop: (p: ReconciledPull) => boolean = () => false,
  ): Promise<ReconcileListing | Spent | null> {
    const pulls: ReconciledPull[] = [];
    for (let page = 1; page <= pages; page++) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown[]>(
        `${pullsOf(fullName)}?${query}&per_page=${RECONCILE_PER_PAGE}&page=${page}`,
        { headers: githubHeaders(token) },
        MAX_PAGE_BYTES,
      );
      if (answer?.status !== 200 || !Array.isArray(answer.body)) return null;
      for (const raw of answer.body) {
        const p = pullOf(raw);
        if (!p) continue;
        if (stop(p)) return { pulls, more: false };
        pulls.push(p);
      }
      if (answer.body.length < RECONCILE_PER_PAGE) return { pulls, more: false };
    }
    return { pulls, more: true };
  }

  return {
    closedSince: (token, fullName, since, pages, calls) =>
      list(token, fullName, "state=closed&sort=updated&direction=desc", pages, calls, (p) =>
        p.updatedAt ? p.updatedAt < since : false,
      ),
    open: (token, fullName, pages, calls) =>
      list(token, fullName, "state=open&sort=created&direction=desc", pages, calls),
    async one(token, fullName, number, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown>(
        `${pullsOf(fullName)}/${number}`,
        { headers: githubHeaders(token) },
        MAX_PAGE_BYTES,
      );
      if (answer?.status === 404) return "missing";
      if (answer?.status !== 200) return null;
      return pullOf(answer.body);
    },
  };
}
