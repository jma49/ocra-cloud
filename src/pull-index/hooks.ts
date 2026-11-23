import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { avatarOf } from "../platforms/changes.js";
import { labelsOf } from "../platforms/pulls.js";
import { applyFacts, type PullFacts } from "./facts.js";
import { freshRepo } from "./fresh.js";

// The webhooks of an enrolled repository's pull requests, kept in the
// inbox's index: a GitHub pull_request delivery or a GitLab merge request
// hook carries the whole pull request, so each is merged as it stands. A
// delivery that moves what the index does not hold (a new head and its
// checks, a review and the review decision, a merge queue, a comment's
// update time), or concerns a repository the index is not fresh for,
// makes the account's next inbox read the platform (./inbox.ts).

type HookRepo = {
  id: string;
  accountId: string;
  host: string;
  paused: string | null;
  pullsIndexedAt: Date | null;
};

/** GitHub actions whose change the index cannot follow: the head (and its checks) or the merge queue. */
const GITHUB_UNFOLLOWED = new Set(["opened", "reopened", "synchronize", "enqueued", "dequeued"]);

const githubUser = z.object({
  id: z.number(),
  login: z.string(),
  avatar_url: z.string().optional(),
});
const githubPull = z.object({
  action: z.string(),
  pull_request: z.object({
    node_id: z.string().optional(),
    number: z.number().int().min(1),
    title: z.string(),
    html_url: z.string(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().optional(),
    created_at: z.string().nullish(),
    updated_at: z.string(),
    merged_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    user: githubUser.nullish(),
    labels: z.array(z.object({ name: z.string() })).nullish(),
    requested_reviewers: z.array(z.object({ id: z.number() })).nullish(),
    assignees: z.array(z.object({ id: z.number() })).nullish(),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z.object({ id: z.number() }).nullish(),
    }),
    base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }),
    additions: z.number().int().optional(),
    deletions: z.number().int().optional(),
  }),
  repository: z.object({ id: z.number() }),
});

/** A time a platform wrote, ISO or GitLab's older `2026-11-02 10:00:00 UTC`; undefined when it is none. */
function hookTime(text: string | null | undefined): Date | undefined {
  if (!text) return undefined;
  const iso = text.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/, "$1T$2Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

function githubFacts(body: unknown): { repoId: string; facts: PullFacts } | null {
  const parsed = githubPull.safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data.pull_request;
  const changedAt = hookTime(p.updated_at);
  if (!changedAt) return null;
  const merged = hookTime(p.merged_at) ?? null;
  return {
    repoId: String(parsed.data.repository.id),
    facts: {
      number: p.number,
      changedAt,
      pullId: p.node_id ?? null,
      title: p.title,
      url: p.html_url,
      author: p.user?.login ?? null,
      authorId: p.user ? String(p.user.id) : null,
      authorAvatar: avatarOf(p.user?.avatar_url),
      draft: p.draft === true,
      state: p.state === "open" ? "open" : merged ? "merged" : "closed",
      openedAt: hookTime(p.created_at) ?? null,
      mergedAt: merged,
      closedAt: p.state === "open" ? null : (merged ?? hookTime(p.closed_at) ?? changedAt),
      labels: labelsOf((p.labels ?? []).map((l) => l.name)),
      head: p.head.sha,
      branches: p.head.repo?.id === p.base.repo.id ? { head: p.head.ref, base: p.base.ref } : null,
      reviewerIds: (p.requested_reviewers ?? []).map((u) => String(u.id)),
      assigneeIds: (p.assignees ?? []).map((u) => String(u.id)),
      ...(p.additions !== undefined ? { additions: p.additions } : {}),
      ...(p.deletions !== undefined ? { deletions: p.deletions } : {}),
    },
  };
}

/** Deliveries that move a pull request's checks or merge queue without the inbox's change signal. */
const GITHUB_CHECK_EVENTS = new Set(["status", "check_run", "merge_group"]);

export const githubMovesChecks = (event: string) => GITHUB_CHECK_EVENTS.has(event);

const githubChecked = z.object({
  sha: z.string().optional(),
  check_run: z.object({ head_sha: z.string() }).optional(),
});

const githubRepo = z.object({ repository: z.object({ id: z.number() }) });

/** A GitHub App delivery that touches the inbox's pulls (src/pull-changes.ts), kept in the index. */
export async function indexGithubEvent(
  db: Db,
  host: string,
  event: string | undefined,
  body: unknown,
  now = new Date(),
): Promise<void> {
  const repoId = githubRepo.safeParse(body);
  if (!repoId.success) return;
  const repo = await reviewRepoFor(db, "github", host, String(repoId.data.repository.id));
  if (!repo) return;
  if (event === "status" || event === "check_run") {
    // A busy default branch's checks are of no pull request the index holds.
    const sha = githubChecked.safeParse(body);
    const head = sha.success ? (sha.data.sha ?? sha.data.check_run?.head_sha) : undefined;
    if (!head || !(await scoped(db, repo.accountId).pullIndex.holdsHead(repo.id, head))) return;
  }
  const read = event === "pull_request" ? githubFacts(body) : null;
  const action = (body as { action?: unknown }).action;
  const followed = read !== null && !GITHUB_UNFOLLOWED.has(String(action));
  await keep(db, "github", repo, read?.facts ?? null, followed, now);
}

const gitlabUser = z.object({
  id: z.number(),
  username: z.string().optional(),
  avatar_url: z.string().nullish(),
});
const gitlabHook = z.object({
  user: gitlabUser.nullish(),
  object_attributes: z.object({
    id: z.number(),
    iid: z.number().int().min(1),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    action: z.string().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    created_at: z.string().nullish(),
    updated_at: z.string(),
    merged_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    author_id: z.number().optional(),
    last_commit: z.object({ id: z.string() }).nullish(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    source_project_id: z.number().optional(),
    target_project_id: z.number().optional(),
  }),
  labels: z.array(z.object({ title: z.string() })).nullish(),
  assignees: z.array(gitlabUser).nullish(),
  reviewers: z.array(gitlabUser).nullish(),
});

export function gitlabFacts(body: unknown): PullFacts | null {
  const parsed = gitlabHook.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: a, user, labels, assignees, reviewers } = parsed.data;
  const changedAt = hookTime(a.updated_at);
  if (!changedAt) return null;
  const state = a.state === "merged" ? "merged" : a.state === "closed" ? "closed" : "open";
  const ended = state === "merged" ? a.merged_at : a.closed_at;
  // The hook names the author only by id: its login is the actor's when the author acted.
  const byAuthor = user && a.author_id === user.id;
  return {
    number: a.iid,
    changedAt,
    pullId: String(a.id),
    title: a.title,
    url: a.url,
    ...(a.author_id !== undefined ? { authorId: String(a.author_id) } : {}),
    ...(byAuthor ? { author: user.username ?? null, authorAvatar: avatarOf(user.avatar_url) } : {}),
    draft: Boolean(a.draft ?? a.work_in_progress),
    state,
    openedAt: hookTime(a.created_at) ?? null,
    mergedAt: state === "merged" ? (hookTime(a.merged_at) ?? changedAt) : null,
    closedAt: state === "open" ? null : (hookTime(ended) ?? changedAt),
    ...(labels ? { labels: labelsOf(labels.map((l) => l.title)) } : {}),
    ...(a.last_commit ? { head: a.last_commit.id } : {}),
    ...(a.source_branch && a.target_branch && a.source_project_id !== undefined
      ? {
          branches:
            a.source_project_id === a.target_project_id
              ? { head: a.source_branch, base: a.target_branch }
              : null,
        }
      : {}),
    ...(reviewers ? { reviewerIds: reviewers.map((u) => String(u.id)) } : {}),
    ...(assignees ? { assigneeIds: assignees.map((u) => String(u.id)) } : {}),
  };
}

/**
 * A GitLab hook its project's secret proved that touches the inbox's pulls
 * (src/pull-changes.ts). The listing holds no pipeline or approvals, so a
 * merge request hook is followed whatever it says; a note moves only the
 * update time, which it does not carry.
 */
export async function indexGitlabEvent(
  db: Db,
  repo: HookRepo,
  kind: string | undefined,
  body: unknown,
  now = new Date(),
): Promise<void> {
  const facts = kind === "Merge Request Hook" ? gitlabFacts(body) : null;
  await keep(db, "gitlab", repo, facts, facts !== null, now);
}

async function keep(
  db: Db,
  platform: "github" | "gitlab",
  repo: HookRepo,
  facts: PullFacts | null,
  followed: boolean,
  now: Date,
): Promise<void> {
  const data = scoped(db, repo.accountId);
  if (facts) await applyFacts(data, repo.id, facts.number, () => facts);
  if (!followed || !freshRepo(repo, now)) await data.pullIndex.stale(platform, repo.host, now);
}
