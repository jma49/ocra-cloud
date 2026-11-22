import { z } from "zod";
import type { MergeIntent } from "../db/merge-intents.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { accessToken } from "../platforms/links.js";
import { advance, type IntentScope, type MergeRunner, recordEnd } from "./advance.js";

// What the platforms' webhooks for an enrolled repository say that may let
// an armed intent merge, or end it: its pull request gained commits, was
// edited, reviewed, merged or closed, or a check or status on a commit
// finished. Read after the webhook is answered, intent by intent.

/** A change of one pull request, or a check that finished on a commit. */
export type PullSignal =
  | { number: number; newHead?: string; closed?: "merged" | "closed" }
  | { head: string };

/** At most this many intents move on one delivery. */
const MAX_PER_SIGNAL = 20;

const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const githubRepo = z.object({ id: z.number(), full_name: z.string() });

const githubPull = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: z.object({ head: z.object({ sha }), merged: z.boolean().optional() }),
  repository: githubRepo,
});
const githubReview = z.object({
  pull_request: z.object({ number: z.number().int().min(1) }),
  repository: githubRepo,
});
const githubCheck = z.object({
  action: z.literal("completed"),
  check_suite: z.object({ head_sha: sha }).optional(),
  check_run: z.object({ head_sha: sha }).optional(),
  repository: githubRepo,
});
const githubStatus = z.object({
  sha,
  state: z.enum(["success", "failure", "error"]),
  repository: githubRepo,
});

/** A GitHub App delivery's signal and the repository it is of; null for one that says nothing here. */
export function githubSignal(
  event: string | undefined,
  body: unknown,
): { repoId: string; fullName: string; signal: PullSignal } | null {
  const of = (repo: z.infer<typeof githubRepo>, signal: PullSignal) => ({
    repoId: String(repo.id),
    fullName: repo.full_name,
    signal,
  });
  if (event === "pull_request") {
    const p = githubPull.safeParse(body);
    if (!p.success) return null;
    const { action, number, pull_request: pull, repository } = p.data;
    if (action === "closed") {
      return of(repository, { number, closed: pull.merged ? "merged" : "closed" });
    }
    if (action === "synchronize") return of(repository, { number, newHead: pull.head.sha });
    return of(repository, { number });
  }
  if (event === "pull_request_review") {
    const p = githubReview.safeParse(body);
    return p.success ? of(p.data.repository, { number: p.data.pull_request.number }) : null;
  }
  if (event === "check_suite" || event === "check_run") {
    const p = githubCheck.safeParse(body);
    const head = p.data?.check_suite?.head_sha ?? p.data?.check_run?.head_sha;
    return p.success && head ? of(p.data.repository, { head }) : null;
  }
  if (event === "status") {
    const p = githubStatus.safeParse(body);
    return p.success ? of(p.data.repository, { head: p.data.sha }) : null;
  }
  return null;
}

const gitlabMergeRequest = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    oldrev: z.string().optional(),
    last_commit: z.object({ id: sha }),
  }),
  project: z.object({ path_with_namespace: z.string() }),
});
const gitlabPipeline = z.object({
  object_attributes: z.object({
    sha,
    status: z.enum(["success", "failed", "canceled", "skipped"]),
  }),
  project: z.object({ path_with_namespace: z.string() }),
});

/** A GitLab hook's signal, from a project whose secret proved it. */
export function gitlabSignal(
  kind: string | undefined,
  body: unknown,
): { fullName: string; signal: PullSignal } | null {
  if (kind === "Merge Request Hook") {
    const p = gitlabMergeRequest.safeParse(body);
    if (!p.success) return null;
    const a = p.data.object_attributes;
    const fullName = p.data.project.path_with_namespace;
    if (a.action === "merge") return { fullName, signal: { number: a.iid, closed: "merged" } };
    if (a.action === "close") return { fullName, signal: { number: a.iid, closed: "closed" } };
    const pushed = a.action === "update" && !!a.oldrev;
    return {
      fullName,
      signal: { number: a.iid, ...(pushed ? { newHead: a.last_commit.id } : {}) },
    };
  }
  if (kind === "Pipeline Hook") {
    const p = gitlabPipeline.safeParse(body);
    if (!p.success) return null;
    return {
      fullName: p.data.project.path_with_namespace,
      signal: { head: p.data.object_attributes.sha },
    };
  }
  return null;
}

/** Moves one armed intent on what the signal says. */
async function onIntent(scope: IntentScope, intent: MergeIntent, signal: PullSignal, now: Date) {
  const intents = scope.data.mergeIntents;
  if ("closed" in signal && signal.closed) {
    const state = signal.closed;
    if (await intents.settle(intent.id, intent.head, { state, reason: null }, now)) {
      await recordEnd(scope, intent, state, null);
    }
    return;
  }
  const newHead = "newHead" in signal ? signal.newHead : undefined;
  if (newHead && newHead !== intent.head) {
    if (intent.keepOnPush) {
      if (!(await intents.settle(intent.id, intent.head, { head: newHead }, now))) return;
      await advance(scope, { ...intent, head: newHead }, now);
      return;
    }
    const change = { state: "disarmed" as const, reason: "head_moved" as const };
    if (!(await intents.settle(intent.id, intent.head, change, now))) return;
    if (intent.mode === "native") {
      // The platform may keep its own auto-merge armed across a push: it is turned off, as the user.
      const token = await accessToken(scope.data, scope.runner.env, scope.platform);
      if (token) await scope.platform.autoMerge.disable(token, intent.fullName, intent.number);
    }
    await recordEnd(scope, intent, "disarmed", "head_moved");
    return;
  }
  await advance(scope, intent, now);
}

/** Moves the armed intents of the enrolled repository that the signal concerns. */
export async function moveIntents(
  runner: MergeRunner,
  repo: Row<"reviewRepos">,
  fullName: string,
  signal: PullSignal,
  now = new Date(),
): Promise<void> {
  const platform = runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) return;
  const data = scoped(runner.db, repo.accountId);
  const key = { platform: repo.platform, host: repo.host, fullName };
  const at = "head" in signal ? { head: signal.head } : { number: signal.number };
  const intents = await data.mergeIntents.active(key, at, MAX_PER_SIGNAL);
  const scope = { runner, data, platform, repo };
  for (const intent of intents) {
    try {
      await onIntent(scope, intent, signal, now);
    } catch (e) {
      logError("merge_when_ready_failed", { repo: repo.id, error: errorName(e) });
    }
  }
}

/** A GitHub App delivery (src/webhooks.ts verified it), for its enrolled repository. */
export async function moveGithubIntents(
  runner: MergeRunner,
  host: string,
  event: string | undefined,
  body: unknown,
): Promise<void> {
  const said = githubSignal(event, body);
  if (!said) return;
  const repo = await reviewRepoFor(runner.db, "github", host, said.repoId);
  if (repo) await moveIntents(runner, repo, said.fullName, said.signal);
}
