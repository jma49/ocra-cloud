import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, scoped } from "../db/scoped.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { hookTime } from "../pull-index/hooks.js";

// Each head an enrolled repository's pull request is pushed to, from its
// webhooks: GitHub's pull_request opened, reopened and synchronize, and a
// GitLab merge request hook that opens, reopens or brings new commits
// (`oldrev`). The push time is the platform's update time where it wrote
// one, else the delivery's.

const GITHUB_PUSHES = new Set(["opened", "reopened", "synchronize"]);

const githubPush = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().min(1),
    updated_at: z.string().nullish(),
    head: z.object({ sha: z.string() }),
  }),
  repository: z.object({ id: z.number() }),
});

const gitlabPush = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    oldrev: z.string().nullish(),
    updated_at: z.string().nullish(),
    last_commit: z.object({ id: z.string() }).nullish(),
  }),
});

/** The platform's update time, else the delivery's. */
const pushTime = (text: string | null | undefined, now: Date) => hookTime(text) ?? now;

/** A GitHub App delivery (src/webhooks.ts verified it); true when it kept a new head. */
export async function recordGithubVersion(
  db: Db,
  host: string,
  event: string,
  body: unknown,
  now = new Date(),
): Promise<boolean> {
  if (event !== "pull_request") return false;
  const parsed = githubPush.safeParse(body);
  if (!parsed.success || !GITHUB_PUSHES.has(parsed.data.action)) return false;
  const { pull_request: pull, repository } = parsed.data;
  const head = pull.head.sha.toLowerCase();
  if (!COMMIT_ID.test(head)) return false;
  const repo = await reviewRepoFor(db, "github", host, String(repository.id));
  if (!repo) return false;
  return scoped(db, repo.accountId).pullVersions.record(repo.id, pull.number, {
    head,
    pushedAt: pushTime(pull.updated_at, now),
    opened: parsed.data.action === "opened",
  });
}

/** A merge request hook its project's secret proved; true when it kept a new head. */
export async function recordGitlabVersion(
  db: Db,
  repo: Pick<Row<"reviewRepos">, "id" | "accountId">,
  body: unknown,
  now = new Date(),
): Promise<boolean> {
  const parsed = gitlabPush.safeParse(body);
  if (!parsed.success) return false;
  const a = parsed.data.object_attributes;
  const pushed =
    a.action === "open" || a.action === "reopen" || (a.action === "update" && !!a.oldrev);
  const head = a.last_commit?.id.toLowerCase();
  if (!pushed || !head || !COMMIT_ID.test(head)) return false;
  return scoped(db, repo.accountId).pullVersions.record(repo.id, a.iid, {
    head,
    pushedAt: pushTime(a.updated_at, now),
    opened: a.action === "open",
  });
}
