import { z } from "zod";
import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { githubSignal, type PullSignal } from "../merge-when-ready/hooks.js";
import { accessToken } from "../platforms/links.js";
import { MAX_STACK } from "../platforms/stacks.js";
import { advanceStack, REQUEST_CALLS, type StackRunner } from "./advance.js";

// What an enrolled repository's webhooks say to stacks: the signals that
// move a merge intent move the stack merge on that layer too, and a pull
// request merged on the platform has the ones stacked on it moved onto its
// base, as the account that enrolled the repository (whose link its other
// server-side writes use), so they do not merge into a branch that landed.

/** A merged pull request's branches. */
export type MergedPull = { number: number; head: string; base: string };

const MAX_PER_SIGNAL = 20;

/** What of a GitHub delivery the stacks read, kept for the delivery's retries (src/inbound/fields.ts). */
const githubMergedBody = z.object({
  action: z.literal("closed"),
  number: z.number().int().min(1),
  pull_request: z.object({
    merged: z.literal(true),
    head: z.object({ ref: z.string().min(1) }),
    base: z.object({ ref: z.string().min(1) }),
  }),
});
const gitlabMergedBody = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.literal("merge"),
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
  }),
});

export const GITHUB_STACK_FIELDS = [githubMergedBody];

/** A GitHub delivery's merged pull request; null for any other. */
export function githubMerged(event: string | undefined, body: unknown): MergedPull | null {
  if (event !== "pull_request") return null;
  const p = githubMergedBody.safeParse(body);
  if (!p.success) return null;
  const { number, pull_request: pull } = p.data;
  return { number, head: pull.head.ref, base: pull.base.ref };
}

/** A GitLab hook's merged merge request; null for any other. */
export function gitlabMerged(kind: string | undefined, body: unknown): MergedPull | null {
  if (kind !== "Merge Request Hook") return null;
  const p = gitlabMergedBody.safeParse(body);
  if (!p.success) return null;
  const a = p.data.object_attributes;
  return { number: a.iid, head: a.source_branch, base: a.target_branch };
}

const platformOf = (runner: StackRunner, repo: Row<"reviewRepos">) =>
  runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);

/** Whether a delivery has stack work: a pull request merged, or a stack merge on what it names. */
export async function hasStackWork(
  db: Db,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal,
  merged: MergedPull | null,
): Promise<boolean> {
  if (merged) return true;
  const key = { platform: repo.platform, host: repo.host, fullName };
  const at = "head" in signal ? { head: signal.head } : { number: signal.number };
  return (await scoped(db, repo.accountId).stackMerges.active(key, at, 1)).length > 0;
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
 * onto that one's base; how many it moved.
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
  let moved = 0;
  for (const pull of (above ?? []).slice(0, MAX_STACK)) {
    if (pull.number === merged.number || pull.base !== merged.head) continue;
    const sent = await platform.stacks.retarget(token, repo.fullName, pull.number, merged.base);
    if (sent !== "done") continue;
    moved++;
    await audit(data, "stack.retargeted", {
      pull: `${repo.fullName}#${pull.number}`,
      base: merged.base,
    });
  }
  return moved;
}

/** A delivery's signal and merged pull request, for the enrolled repository's stacks. */
export async function moveStacks(
  runner: StackRunner,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal | undefined,
  merged: MergedPull | null | undefined,
) {
  try {
    if (merged) await restackOnMerge(runner, repo, merged);
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
  if (repo) await moveStacks(runner, repo, said.fullName, said.signal, githubMerged(event, body));
}
