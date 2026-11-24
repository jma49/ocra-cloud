import { z } from "zod";
import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { githubSignal, type PullSignal } from "../merge-when-ready/hooks.js";
import { accessToken } from "../platforms/links.js";
import { MAX_STACK, type OpenPull } from "../platforms/stacks.js";
import { advanceStack, REQUEST_CALLS, type StackRunner } from "./advance.js";
import { mergeKey, queueRestacks } from "./restack.js";

// What an enrolled repository's webhooks say to stacks: the signals that
// move a merge intent move the stack merge on that layer too, and a pull
// request merged on the platform has the ones stacked on it moved onto its
// base, as the account that enrolled the repository (whose link its other
// server-side writes use), so they do not merge into a branch that landed;
// where the repository turned restacks on, each moved one is queued to be
// rebased there too (./restack.ts). GitHub moves them itself when it deletes
// the merged head branch, and GitLab when it deletes the merged source
// branch (at most four), sometimes before the merge's delivery is handled,
// which then finds none: each such move's own delivery queues its restack,
// under the same key, so the two never queue it twice. The move's delivery
// may also come first, before the merge's has indexed it: the platform is
// then asked which pull request merged from the old base.

/**
 * A merged pull request's branches, and its head and merge commit where the
 * delivery named them (a delivery kept before they were read names neither).
 */
export type MergedPull = {
  number: number;
  head: string;
  base: string;
  headSha?: string;
  mergeCommit?: string | null;
};

/** A pull request moved off `from` onto `base`, its head branch in the repository. */
export type RetargetedPull = {
  number: number;
  from: string;
  base: string;
  head: string;
  headSha: string;
};

const MAX_PER_SIGNAL = 20;

/**
 * How long after a merge a pull request moved off its head branch is taken
 * as moved by that merge: past the platform's own move, the delivery's
 * retries (src/inbound/run.ts) end within it.
 */
const RETARGET_WINDOW_MS = 2 * 60 * 60_000;

/** What of a GitHub delivery the stacks read, kept for the delivery's retries (src/inbound/fields.ts). */
const githubMergedBody = z.object({
  action: z.literal("closed"),
  number: z.number().int().min(1),
  pull_request: z.object({
    merged: z.literal(true),
    merge_commit_sha: z.string().nullish(),
    head: z.object({ ref: z.string().min(1), sha: z.string().optional() }),
    base: z.object({ ref: z.string().min(1) }),
  }),
});
const gitlabMergedBody = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.literal("merge"),
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
    last_commit: z.object({ id: z.string() }).optional(),
    merge_commit_sha: z.string().nullish(),
    squash_commit_sha: z.string().nullish(),
  }),
});

const githubRetargetedBody = z.object({
  action: z.literal("edited"),
  number: z.number().int().min(1),
  changes: z.object({ base: z.object({ ref: z.object({ from: z.string().min(1) }) }) }),
  pull_request: z.object({
    state: z.literal("open"),
    head: z.object({
      ref: z.string().min(1),
      sha: z.string(),
      repo: z.object({ id: z.number() }).nullish(),
    }),
    base: z.object({ ref: z.string().min(1), repo: z.object({ id: z.number() }) }),
  }),
});

// GitLab sends it for its own move (its source-branch deletion's retarget),
// for a user's and for ocra's alike (src/platforms/gitlab-stack.ts).
const gitlabRetargetedBody = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.literal("update"),
    state: z.literal("opened"),
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
    source_project_id: z.number(),
    target_project_id: z.number(),
    last_commit: z.object({ id: z.string() }),
  }),
  changes: z.object({
    target_branch: z.object({ previous: z.string().min(1), current: z.string().min(1) }),
  }),
});

export const GITHUB_STACK_FIELDS = [githubMergedBody, githubRetargetedBody];

/** A GitHub delivery's open pull request moved to another base, its head in the repository; null for any other. */
export function githubRetargeted(event: string | undefined, body: unknown): RetargetedPull | null {
  if (event !== "pull_request") return null;
  const p = githubRetargetedBody.safeParse(body);
  if (!p.success) return null;
  const { number, changes, pull_request: pull } = p.data;
  if (pull.head.repo?.id !== pull.base.repo.id || changes.base.ref.from === pull.base.ref) {
    return null;
  }
  return {
    number,
    from: changes.base.ref.from,
    base: pull.base.ref,
    head: pull.head.ref,
    headSha: pull.head.sha,
  };
}

/** A GitLab hook's open merge request moved to another target, its source in the project; else null. */
export function gitlabRetargeted(kind: string | undefined, body: unknown): RetargetedPull | null {
  if (kind !== "Merge Request Hook") return null;
  const p = gitlabRetargetedBody.safeParse(body);
  if (!p.success) return null;
  const { object_attributes: a, changes } = p.data;
  const from = changes.target_branch.previous;
  if (a.source_project_id !== a.target_project_id || from === a.target_branch) return null;
  return {
    number: a.iid,
    from,
    base: a.target_branch,
    head: a.source_branch,
    headSha: a.last_commit.id,
  };
}

/** A GitHub delivery's merged pull request; null for any other. */
export function githubMerged(event: string | undefined, body: unknown): MergedPull | null {
  if (event !== "pull_request") return null;
  const p = githubMergedBody.safeParse(body);
  if (!p.success) return null;
  const { number, pull_request: pull } = p.data;
  return {
    number,
    head: pull.head.ref,
    base: pull.base.ref,
    ...(pull.head.sha ? { headSha: pull.head.sha } : {}),
    ...(pull.merge_commit_sha ? { mergeCommit: pull.merge_commit_sha } : {}),
  };
}

/** A GitLab hook's merged merge request; null for any other. */
export function gitlabMerged(kind: string | undefined, body: unknown): MergedPull | null {
  if (kind !== "Merge Request Hook") return null;
  const p = gitlabMergedBody.safeParse(body);
  if (!p.success) return null;
  const a = p.data.object_attributes;
  const merge = a.squash_commit_sha ?? a.merge_commit_sha;
  return {
    number: a.iid,
    head: a.source_branch,
    base: a.target_branch,
    ...(a.last_commit ? { headSha: a.last_commit.id } : {}),
    ...(merge ? { mergeCommit: merge } : {}),
  };
}

const platformOf = (runner: StackRunner, repo: Row<"reviewRepos">) =>
  runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);

/**
 * Whether a delivery has stack work: a pull request merged, one moved to
 * another base where the repository restacks (whether its old base merged
 * lately may be known to the platform only), or a stack merge on what it
 * names.
 */
export async function hasStackWork(
  db: Db,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal,
  merged: MergedPull | null,
  retargeted: RetargetedPull | null = null,
): Promise<boolean> {
  if (merged || (retargeted && repo.restack)) return true;
  const data = scoped(db, repo.accountId);
  const key = { platform: repo.platform, host: repo.host, fullName };
  const at = "head" in signal ? { head: signal.head } : { number: signal.number };
  return (await data.stackMerges.active(key, at, 1)).length > 0;
}

/** Moves the stack merges of the enrolled repository that the signal concerns. */
export async function moveStackMerges(
  runner: StackRunner,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal,
  now = new Date(),
): Promise<void> {
  const platform = platformOf(runner, repo);
  if (!platform) return;
  const data = scoped(runner.db, repo.accountId);
  const key = { platform: repo.platform, host: repo.host, fullName };
  const at = "head" in signal ? { head: signal.head } : { number: signal.number };
  for (const merge of await data.stackMerges.active(key, at, MAX_PER_SIGNAL)) {
    try {
      // A delivery's work runs in the request that brought it.
      await advanceStack({ runner, data, platform }, merge, now, REQUEST_CALLS);
    } catch (e) {
      logError("stack_merge_failed", { repo: repo.id, error: errorName(e) });
    }
  }
}

/**
 * Moves the open pull requests whose base is a merged one's head branch
 * onto that one's base, and queues their restacks where the repository
 * wants them; how many it moved.
 */
export async function restackOnMerge(
  runner: StackRunner,
  repo: Row<"reviewRepos">,
  merged: MergedPull,
): Promise<number> {
  const platform = platformOf(runner, repo);
  if (!platform || merged.head === merged.base) return 0;
  const data = scoped(runner.db, repo.accountId);
  const token = await accessToken(data, runner.env, platform);
  if (!token) return 0;
  const above = await platform.stacks.children(token, repo.fullName, merged.head);
  const moved: OpenPull[] = [];
  for (const pull of (above ?? []).slice(0, MAX_STACK)) {
    if (pull.number === merged.number || pull.base !== merged.head) continue;
    const sent = await platform.stacks.retarget(token, repo.fullName, pull.number, merged.base);
    if (sent !== "done") continue;
    moved.push(pull);
    await audit(data, "stack.retargeted", {
      pull: `${repo.fullName}#${pull.number}`,
      base: merged.base,
    });
  }
  if (merged.headSha && moved.length > 0) {
    const parent = {
      number: merged.number,
      merge: mergeKey(merged.mergeCommit, merged.headSha),
      head: merged.headSha,
      onto: { branch: merged.base, commit: null },
    };
    await queueRestacks(data, repo, parent, moved);
  }
  return moved.length;
}

/**
 * Queues the restack of a pull request the platform moved off the head
 * branch of one merged lately onto that one's base, where the repository
 * restacks; whether it queued. The merged one is the index's, else, when
 * the merge's delivery has not indexed it yet, the platform's (one call).
 * The merge's commit and head are the platform's, so the key is the one the
 * merge's own delivery queues under.
 */
async function restackOnRetarget(
  runner: StackRunner,
  repo: Row<"reviewRepos">,
  moved: RetargetedPull,
  now = new Date(),
): Promise<boolean> {
  const platform = platformOf(runner, repo);
  if (!platform || !repo.restack) return false;
  const data = scoped(runner.db, repo.accountId);
  const since = new Date(now.getTime() - RETARGET_WINDOW_MS);
  const indexed = await data.pullIndex.mergedFrom(repo.id, moved.from, since);
  const token = await accessToken(data, runner.env, platform);
  if (!token) return false;
  const number =
    indexed?.number ??
    (await platform.stacks.mergedFrom(token, repo.fullName, moved.from, moved.base, since));
  if (number === null) return false;
  const was = await platform.stacks.standing(token, repo.fullName, number);
  if (was?.state !== "merged" || was.headBranch !== moved.from || was.base !== moved.base) {
    return false;
  }
  const parent = {
    number,
    merge: mergeKey(was.mergeCommit, was.head),
    head: was.head,
    onto: { branch: moved.base, commit: null },
  };
  return (await queueRestacks(data, repo, parent, [moved])) > 0;
}

/** A delivery's signal and merged or moved pull request, for the enrolled repository's stacks. */
export async function moveStacks(
  runner: StackRunner,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal | undefined,
  merged: MergedPull | null | undefined,
  retargeted: RetargetedPull | null = null,
) {
  try {
    if (merged) await restackOnMerge(runner, repo, merged);
    if (retargeted) await restackOnRetarget(runner, repo, retargeted);
  } catch (e) {
    logError("stack_restack_failed", { repo: repo.id, error: errorName(e) });
  }
  if (signal) await moveStackMerges(runner, repo, fullName, signal);
}

/** A GitHub App delivery (src/webhooks.ts verified it), for its enrolled repository. */
export async function moveGithubStacks(
  runner: StackRunner,
  host: string,
  event: string | undefined,
  body: unknown,
): Promise<void> {
  const said = githubSignal(event, body);
  if (!said) return;
  const repo = await reviewRepoFor(runner.db, "github", host, said.repoId);
  if (!repo) return;
  const merged = githubMerged(event, body);
  await moveStacks(runner, repo, said.fullName, said.signal, merged, githubRetargeted(event, body));
}
