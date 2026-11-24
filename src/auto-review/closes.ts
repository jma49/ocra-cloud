import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { repoIdentity } from "../platforms/platform.js";

// When an enrolled repository's pull request is merged or closed, as its
// platform's webhook says, kept for the digest and the weekly report. A
// webhook names its own times where it has them; otherwise it arrives as
// the pull request closes, and its arrival is the time. A close ends the
// pull request's `@ocra pause` (./commands.ts): one paused again after a
// reopen is paused anew. A merge also settles ocra's findings on the pull
// request that are still open: merged, not fixed, since nothing saw them
// fixed (src/db/finding-outcomes.ts). A close without a merge leaves them
// open: the pull request may be reopened.

type Repo = { id: string; accountId: string; fullName: string };

/** A time the platform wrote, or null when it is missing or not one. */
function timeOf(text: string | null | undefined): Date | null {
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const githubClosed = z.object({
  action: z.literal("closed"),
  number: z.number().int().min(1),
  pull_request: z.object({
    title: z.string().max(1024),
    merged: z.boolean().optional(),
    created_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    merged_at: z.string().nullish(),
  }),
  repository: z.object({ id: z.number() }),
});

/** A GitHub App webhook's pull request event (src/webhooks.ts verified it); whether it recorded a close. */
export async function recordGithubClose(
  db: Db,
  host: string,
  platformUrl: string,
  body: unknown,
  now = new Date(),
): Promise<boolean> {
  const parsed = githubClosed.safeParse(body);
  if (!parsed.success) return false;
  const { number, pull_request: pull, repository } = parsed.data;
  const repo = await reviewRepoFor(db, "github", host, String(repository.id));
  if (!repo) return false;
  const merged = pull.merged === true;
  await record(db, repo, platformUrl, {
    number,
    title: pull.title,
    merged,
    openedAt: timeOf(pull.created_at),
    closedAt: timeOf(merged ? pull.merged_at : pull.closed_at) ?? now,
  });
  return true;
}

const gitlabClosed = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.enum(["merge", "close"]),
    state: z.enum(["merged", "closed"]),
    title: z.string().max(1024),
    created_at: z.string().nullish(),
  }),
});

/** A GitLab merge request hook its repository's secret proved; whether it recorded a close. */
export async function recordGitlabClose(
  db: Db,
  repo: Repo,
  platformUrl: string,
  body: unknown,
  now = new Date(),
): Promise<boolean> {
  const parsed = gitlabClosed.safeParse(body);
  if (!parsed.success) return false;
  const a = parsed.data.object_attributes;
  await record(db, repo, platformUrl, {
    number: a.iid,
    title: a.title,
    merged: a.state === "merged",
    openedAt: timeOf(a.created_at),
    closedAt: now,
  });
  return true;
}

/** GitHub writes its times in whole seconds: a pause made in the second it closed ends with it. */
const CLOSE_SLACK_MS = 1000;

/** The repository as a review's prRepository names it, lower case; null when its address is not one. */
function identityOf(platformUrl: string, repo: Repo): string | null {
  try {
    return repoIdentity({ url: platformUrl }, repo.fullName).toLowerCase();
  } catch {
    return null;
  }
}

async function record(
  db: Db,
  repo: Repo,
  platformUrl: string,
  close: { number: number; title: string; merged: boolean; openedAt: Date | null; closedAt: Date },
) {
  const data = scoped(db, repo.accountId);
  await data.closedPulls.record({ ...close, reviewRepoId: repo.id });
  const ended = new Date(close.closedAt.getTime() + CLOSE_SLACK_MS);
  await data.commands.closed(repo.id, close.number, ended);
  const identity = close.merged ? identityOf(platformUrl, repo) : null;
  if (identity) {
    await data.findingOutcomes.markMerged({ identity, number: close.number }, close.closedAt);
  }
}
