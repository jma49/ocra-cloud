import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { teamReviewerId } from "../db/review-teams.js";
import { scoped } from "../db/scoped.js";

// Whose review an enrolled repository's pull request waits for, by the
// platform's id of each reviewer, as its webhooks say: asked, asked no
// more, or reviewed (src/db/review-requests.ts). Review reminders read it
// (src/notify/reminders.ts); nothing asks the platform. An ask of a GitHub
// team is kept under the team ("team:<id>", ./teams.ts says who is on it),
// as is a GitLab approval rule's group (src/notify/gitlab-groups.ts); a
// review, or approval, by one of its members ends it.

type Repo = { id: string; accountId: string; host: string };

function timeOf(text: string | null | undefined, now: Date): Date {
  const ms = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms) : now;
}

const githubUser = z.object({ id: z.number(), login: z.string().optional() });

const githubPullEvent = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: z.object({ updated_at: z.string().nullish() }),
  requested_reviewer: githubUser.optional(),
  requested_team: z.object({ id: z.number(), slug: z.string().min(1).max(100) }).optional(),
  repository: z.object({ id: z.number(), owner: z.object({ login: z.string() }).optional() }),
});

/** The team a pull_request delivery asked, or asked no more: its org and slug, as GitHub names them. */
export function githubAskedTeam(
  body: unknown,
): { id: number; org: string; slug: string; asked: boolean } | null {
  const parsed = githubPullEvent.safeParse(body);
  if (!parsed.success) return null;
  const { requested_team: team, repository, action } = parsed.data;
  const org = repository.owner?.login;
  return team && org
    ? { id: team.id, org, slug: team.slug, asked: action === "review_requested" }
    : null;
}

const githubReviewEvent = z.object({
  action: z.literal("submitted"),
  review: z.object({ user: githubUser.nullable(), submitted_at: z.string().nullish() }),
  pull_request: z.object({ number: z.number().int().min(1) }),
  repository: z.object({ id: z.number() }),
});

/** A GitHub App webhook's ask, removed ask or review (src/webhooks.ts verified it); whether it recorded one. */
export async function recordGithubRequest(
  db: Db,
  host: string,
  event: string | undefined,
  body: unknown,
  now = new Date(),
): Promise<boolean> {
  if (event === "pull_request_review") {
    const parsed = githubReviewEvent.safeParse(body);
    if (!parsed.success) return false;
    const { review, pull_request: pull, repository } = parsed.data;
    const repo = await reviewRepoFor(db, "github", host, String(repository.id));
    if (!repo || !review.user) return false;
    const done = {
      reviewRepoId: repo.id,
      number: pull.number,
      reviewerId: String(review.user.id),
      reviewer: review.user.login ?? null,
      at: timeOf(review.submitted_at, now),
    };
    const requests = scoped(db, repo.accountId).reviewRequests;
    await requests.done(done);
    await requests.doneByMember({ ...done, platform: "github", host });
    return true;
  }
  if (event !== "pull_request") return false;
  const parsed = githubPullEvent.safeParse(body);
  if (!parsed.success) return false;
  const { action, number, pull_request: pull, requested_reviewer: reviewer } = parsed.data;
  const asked = action === "review_requested";
  const team = githubAskedTeam(body);
  const who = reviewer
    ? { reviewerId: String(reviewer.id), reviewer: reviewer.login ?? null }
    : team && { reviewerId: teamReviewerId(team.id), reviewer: `${team.org}/${team.slug}` };
  if (!who || (!asked && action !== "review_request_removed")) return false;
  const repo = await reviewRepoFor(db, "github", host, String(parsed.data.repository.id));
  if (!repo) return false;
  const e = { reviewRepoId: repo.id, number, ...who, at: timeOf(pull.updated_at, now) };
  const requests = scoped(db, repo.accountId).reviewRequests;
  await (asked ? requests.asked(e) : requests.done(e));
  return true;
}

const gitlabUser = z.object({ id: z.number(), username: z.string().optional() });

const gitlabEvent = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    author_id: z.number().optional(),
    created_at: z.string().nullish(),
    reviewer_ids: z.array(z.number()).optional(),
  }),
  user: gitlabUser.optional(),
  reviewers: z.array(gitlabUser).nullish(),
  changes: z
    .object({
      reviewers: z
        .object({
          previous: z.array(gitlabUser).nullish(),
          current: z.array(gitlabUser).nullish(),
        })
        .optional(),
    })
    .optional(),
});

const APPROVALS = new Set(["approved", "approval"]);

/** A GitLab merge request hook its repository's secret proved; how many asks it moved. */
export async function recordGitlabRequests(
  db: Db,
  repo: Repo,
  body: unknown,
  now = new Date(),
): Promise<number> {
  const parsed = gitlabEvent.safeParse(body);
  if (!parsed.success) return 0;
  const { object_attributes: a, user, reviewers, changes } = parsed.data;
  const logins = new Map<number, string>();
  for (const u of [
    ...(reviewers ?? []),
    ...(changes?.reviewers?.previous ?? []),
    ...(changes?.reviewers?.current ?? []),
    ...(user ? [user] : []),
  ])
    if (u.username) logins.set(u.id, u.username);
  const before = (changes?.reviewers?.previous ?? []).map((u) => u.id);
  const after = (changes?.reviewers?.current ?? []).map((u) => u.id);
  const asked = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (a.action === "open")
    asked.push(...(a.reviewer_ids ?? []).filter((id) => !asked.includes(id)));
  const approved =
    a.action && APPROVALS.has(a.action) && user && user.id !== a.author_id ? user.id : null;
  if (approved) removed.push(approved);
  const requests = scoped(db, repo.accountId).reviewRequests;
  const at = a.action === "open" ? timeOf(a.created_at, now) : now;
  const of = (id: number) => ({
    reviewRepoId: repo.id,
    number: a.iid,
    reviewerId: String(id),
    reviewer: logins.get(id) ?? null,
    at,
  });
  for (const id of asked) await requests.asked(of(id));
  for (const id of removed) await requests.done(of(id));
  // An approval by a member of a group the approval rules asked ends that group's ask.
  if (approved)
    await requests.doneByMember({ ...of(approved), platform: "gitlab", host: repo.host });
  return asked.length + removed.length;
}
