import { z } from "zod";
import type { CallBudget } from "../calls.js";
import { avatarOf } from "./changes.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformJson } from "./http.js";
import { labelsOf } from "./pulls.js";
import {
  RECONCILE_PER_PAGE,
  type ReconciledAsk,
  type ReconciledPull,
  type ReconciledReview,
  type ReconcileListing,
  type RepoReconcile,
  type Spent,
  timeOf,
} from "./reconcile.js";
import { isBotLogin } from "./reviewers.js";

// GitHub's REST list of a repository's pull requests: closed ones by their
// latest change, newest first, read until one changed before `since`; open
// ones in full, up to the page cap, each with the users and teams it asks
// a review of; an open one's reviews, one page of them.

/** A page of a hundred pull requests, bodies included. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const pull = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  user: z
    .object({ login: z.string(), id: z.number(), avatar_url: z.string().optional() })
    .nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  requested_reviewers: z.array(z.object({ login: z.string(), id: z.number() })).nullish(),
  requested_teams: z
    .array(z.object({ id: z.number(), slug: z.string().min(1).max(100) }))
    .nullish(),
  node_id: z.string().optional(),
  html_url: z.string().optional(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
  assignees: z.array(z.object({ id: z.number() })).nullish(),
  head: z
    .object({ sha: z.string(), ref: z.string(), repo: z.object({ id: z.number() }).nullish() })
    .optional(),
  base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullish() }).optional(),
});

const named = z.object({ full_name: z.string().min(3).max(400) });

const review = z.object({
  id: z.number(),
  user: z.object({ login: z.string(), id: z.number(), type: z.string().optional() }).nullish(),
  state: z.string(),
  submitted_at: z.string().nullish(),
});

function asksOf(p: z.infer<typeof pull>, org: string): ReconciledAsk[] {
  return [
    ...(p.requested_reviewers ?? []).map((u) => ({ team: false, id: String(u.id), name: u.login })),
    ...(p.requested_teams ?? []).map((t) => ({
      team: true,
      id: String(t.id),
      name: `${org}/${t.slug}`,
    })),
  ];
}

function reviewOf(raw: unknown): ReconciledReview | null {
  const parsed = review.safeParse(raw);
  // A pending review is the reviewer's draft: it was not submitted.
  if (!parsed.success || !parsed.data.user || parsed.data.state === "PENDING") return null;
  const { id, user, state, submitted_at } = parsed.data;
  return {
    reviewKey: `github:${id}`,
    reviewerId: String(user.id),
    reviewer: user.login,
    bot: user.type === "Bot" || isBotLogin(user.login),
    approved: state.toLowerCase() === "approved",
    submittedAt: timeOf(submitted_at),
  };
}

function pullOf(raw: unknown, org: string): ReconciledPull | null {
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
    asks: asksOf(p, org),
    ...(p.html_url
      ? {
          listed: {
            pullId: p.node_id ?? null,
            url: p.html_url,
            authorAvatar: avatarOf(p.user?.avatar_url),
            labels: labelsOf((p.labels ?? []).map((l) => l.name)),
            assigneeIds: (p.assignees ?? []).map((u) => String(u.id)),
            head: p.head?.sha ?? null,
            branches:
              p.head && p.base && p.head.repo && p.head.repo.id === p.base.repo?.id
                ? { head: p.head.ref, base: p.base.ref }
                : null,
          },
        }
      : {}),
  };
}

export function githubReconcile(host: GithubHost): RepoReconcile {
  const pullsOf = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}/pulls`;
  const orgOf = (fullName: string) => fullName.split("/")[0] ?? "";

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
        const p = pullOf(raw, orgOf(fullName));
        if (!p) continue;
        if (stop(p)) return { pulls, more: false };
        pulls.push(p);
      }
      if (answer.body.length < RECONCILE_PER_PAGE) return { pulls, more: false };
    }
    return { pulls, more: true };
  }

  return {
    async name(token, platformRepoId, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown>(
        `${host.api}/repositories/${encodeURIComponent(platformRepoId)}`,
        { headers: githubHeaders(token) },
        MAX_PAGE_BYTES,
      );
      const parsed = answer?.status === 200 ? named.safeParse(answer.body) : null;
      return parsed?.success ? parsed.data.full_name : null;
    },
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
      return pullOf(answer.body, orgOf(fullName));
    },
    async reviews(token, fullName, number, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown[]>(
        `${pullsOf(fullName)}/${number}/reviews?per_page=${RECONCILE_PER_PAGE}`,
        { headers: githubHeaders(token) },
        MAX_PAGE_BYTES,
      );
      if (answer?.status !== 200 || !Array.isArray(answer.body)) return null;
      return answer.body.flatMap((raw) => reviewOf(raw) ?? []);
    },
  };
}
