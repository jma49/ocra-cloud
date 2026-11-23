import { z } from "zod";
import type { CallBudget } from "../calls.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformJson } from "./http.js";
import {
  RECONCILE_PER_PAGE,
  type ReconciledPull,
  type ReconciledReview,
  type ReconcileListing,
  type RepoReconcile,
  type Spent,
  timeOf,
} from "./reconcile.js";
import { isBotLogin } from "./reviewers.js";

// GitLab's list of a project's merge requests: those changed since, of any
// state, newest change first, keeping the merged and closed ones; open ones
// in full, up to the page cap, each with its reviewers. A locked merge
// request is still open. An open one's approvals are its reviews, as its
// webhook keeps them; GitLab keeps a reviewer who approved among its
// reviewers, so an approver's ask is not one it still waits for.

const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const mergeRequest = z.object({
  iid: z.number().int().min(1),
  title: z.string(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  author: z.object({ username: z.string(), id: z.number() }).nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  reviewers: z.array(z.object({ username: z.string(), id: z.number() })).nullish(),
});

const named = z.object({ path_with_namespace: z.string().min(3).max(400) });

const approvals = z.object({
  approved_by: z
    .array(
      z.object({
        user: z.object({ username: z.string(), id: z.number() }).nullish(),
        approved_at: z.string().nullish(),
      }),
    )
    .nullish(),
});

function pullOf(raw: unknown): ReconciledPull | null {
  const parsed = mergeRequest.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const state = m.state === "merged" ? "merged" : m.state === "closed" ? "closed" : "open";
  return {
    number: m.iid,
    title: m.title,
    author: m.author?.username ?? null,
    authorId: m.author ? String(m.author.id) : null,
    draft: m.draft === true || m.work_in_progress === true,
    state,
    openedAt: timeOf(m.created_at),
    updatedAt: timeOf(m.updated_at),
    closedAt:
      state === "open"
        ? null
        : (timeOf(state === "merged" ? m.merged_at : m.closed_at) ?? timeOf(m.updated_at)),
    asks: (m.reviewers ?? []).map((u) => ({ team: false, id: String(u.id), name: u.username })),
  };
}

export function gitlabReconcile(origin: string): RepoReconcile {
  const listOf = (fullName: string) =>
    `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/merge_requests`;

  async function list(
    token: string,
    fullName: string,
    query: string,
    pages: number,
    calls: CallBudget,
    keep: (p: ReconciledPull) => boolean,
  ): Promise<ReconcileListing | Spent | null> {
    const pulls: ReconciledPull[] = [];
    for (let page = 1; page <= pages; page++) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown[]>(
        `${listOf(fullName)}?${query}&per_page=${RECONCILE_PER_PAGE}&page=${page}`,
        { headers: gitlabHeaders(token) },
        MAX_PAGE_BYTES,
      );
      if (answer?.status !== 200 || !Array.isArray(answer.body)) return null;
      for (const raw of answer.body) {
        const p = pullOf(raw);
        if (p && keep(p)) pulls.push(p);
      }
      if (answer.body.length < RECONCILE_PER_PAGE) return { pulls, more: false };
    }
    return { pulls, more: true };
  }

  return {
    async name(token, platformRepoId, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown>(
        `${origin}/api/v4/projects/${encodeURIComponent(platformRepoId)}`,
        { headers: gitlabHeaders(token) },
        MAX_PAGE_BYTES,
      );
      const parsed = answer?.status === 200 ? named.safeParse(answer.body) : null;
      return parsed?.success ? parsed.data.path_with_namespace : null;
    },
    closedSince: (token, fullName, since, pages, calls) =>
      list(
        token,
        fullName,
        `state=all&order_by=updated_at&sort=desc&updated_after=${encodeURIComponent(since.toISOString())}`,
        pages,
        calls,
        (p) => p.state !== "open",
      ),
    open: (token, fullName, pages, calls) =>
      list(token, fullName, "state=opened&order_by=created_at&sort=desc", pages, calls, () => true),
    async one(token, fullName, number, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown>(
        mergeRequestUrl(origin, fullName, number),
        { headers: gitlabHeaders(token) },
        MAX_PAGE_BYTES,
      );
      if (answer?.status === 404) return "missing";
      if (answer?.status !== 200) return null;
      return pullOf(answer.body);
    },
    async reviews(token, fullName, number, calls) {
      if (!calls.has()) return "spent";
      const answer = await platformJson<unknown>(
        `${mergeRequestUrl(origin, fullName, number)}/approvals`,
        { headers: gitlabHeaders(token) },
        MAX_PAGE_BYTES,
      );
      const parsed = answer?.status === 200 ? approvals.safeParse(answer.body) : null;
      if (!parsed?.success) return null;
      return (parsed.data.approved_by ?? []).flatMap(({ user, approved_at }): ReconciledReview[] =>
        user
          ? [
              {
                reviewKey: `gitlab:${number}:approval:${user.id}`,
                reviewerId: String(user.id),
                reviewer: user.username,
                bot: isBotLogin(user.username),
                approved: true,
                submittedAt: timeOf(approved_at),
              },
            ]
          : [],
      );
    },
  };
}
