import { type Context, Hono } from "hono";
import { z } from "zod";
import { automate } from "../automations/run.js";
import { sameText, sha256Hex } from "../crypto.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { defer } from "../defer.js";
import { MAX_HOOK_BODY } from "../graph/webhooks.js";
import { apiError, jsonBody } from "../http.js";
import { gitlabSignal, moveIntents } from "../merge-when-ready/hooks.js";
import { runnerOf } from "../merge-when-ready/routes.js";
import { publicOutbox } from "../notify/notify.js";
import { tellGitlabHook } from "../notify/pull-hooks.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { gitlabClientOf } from "../platforms/registry.js";
import type { AppEnv } from "../types.js";
import { recordGitlabClose } from "./closes.js";
import { recordGitlabFlow } from "./flows.js";
import { gitlabNote, queueGitlabNote } from "./replies.js";
import type { AutoReviewService } from "./routes.js";

// A pull request of an enrolled repository is queued for review when it
// opens, reopens, leaves draft or gains commits (ADR-0046, 2). A draft is
// not. Its pre-merge checks are evaluated then, and again when its title or
// description is edited. GitLab's note hook, on the same address, queues
// answers (./replies.ts); its merge request and pipeline hooks also move
// the intents armed to merge when ready (src/merge-when-ready/).

type PullChange = {
  fullName: string;
  number: number;
  head: string;
  /** Opened, reopened or out of draft, rather than given commits. */
  opened: boolean;
  facts: { author?: string; baseBranch?: string; title?: string; labels?: string[] };
};

const GITHUB_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

const githubPull = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: z.object({
    draft: z.boolean().optional(),
    head: z.object({ sha: z.string() }),
    title: z.string().optional(),
    user: z.object({ login: z.string() }).optional(),
    base: z.object({ ref: z.string() }).optional(),
    labels: z.array(z.object({ name: z.string() })).optional(),
  }),
  repository: z.object({ id: z.number(), full_name: z.string() }),
});

/** A GitHub App webhook's pull request event (src/webhooks.ts verified it). */
export async function queueGithubPull(
  c: Context<AppEnv>,
  service: AutoReviewService,
  body: unknown,
): Promise<number> {
  const parsed = githubPull.safeParse(body);
  if (!parsed.success) return 0;
  const { action, number, pull_request: pull, repository } = parsed.data;
  const reviews = GITHUB_ACTIONS.has(action);
  if ((!reviews && action !== "edited") || pull.draft) return 0;
  const repo = await reviewRepoFor(c.var.db, "github", "github.com", String(repository.id));
  if (!repo) return 0;
  if (!reviews) {
    service.checkPull?.(repo.accountId, repo.id, number);
    return 0;
  }
  return queue(c, service, repo, {
    fullName: repository.full_name,
    number,
    head: pull.head.sha,
    opened: action !== "synchronize",
    facts: {
      ...(pull.user ? { author: pull.user.login } : {}),
      ...(pull.base ? { baseBranch: pull.base.ref } : {}),
      ...(pull.title !== undefined ? { title: pull.title } : {}),
      ...(pull.labels ? { labels: pull.labels.map((l) => l.name) } : {}),
    },
  });
}

// GitLab says an update gained commits by naming the head it had before.
const gitlabMergeRequest = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    draft: z.boolean().optional(),
    // What GitLab before 15.0 sends instead of draft.
    work_in_progress: z.boolean().optional(),
    oldrev: z.string().optional(),
    last_commit: z.object({ id: z.string() }),
    title: z.string().optional(),
    target_branch: z.string().optional(),
  }),
  project: z.object({ id: z.number(), path_with_namespace: z.string() }),
  // Who caused the event: the author only when the merge request opens.
  user: z.object({ username: z.string() }).optional(),
  labels: z.array(z.object({ title: z.string() })).optional(),
});

const gitlabProject = z.object({ project: z.object({ id: z.number() }) });

type MergeRequestChange = z.infer<typeof gitlabMergeRequest>["object_attributes"];

const isDraft = (a: MergeRequestChange) => a.draft ?? a.work_in_progress ?? false;

const gitlabQueues = (a: MergeRequestChange) =>
  !isDraft(a) &&
  (a.action === "open" || a.action === "reopen" || (a.action === "update" && !!a.oldrev));

/** An update without new commits: its title or description may have changed. */
const gitlabEdited = (a: MergeRequestChange) => !isDraft(a) && a.action === "update" && !a.oldrev;

/** GitLab's merge request hooks, each proven by the secret of the repository it names. */
export function autoReviewWebhooks(service: AutoReviewService) {
  const hooks = new Hono<AppEnv>();
  hooks.post("/gitlab", jsonBody(z.looseObject({}), { max: MAX_HOOK_BODY }), async (c) => {
    const client = gitlabClientOf(c.env);
    if (!client) return apiError(c, "not_found");
    const token = c.req.header("x-gitlab-token");
    if (!token) return apiError(c, "unauthenticated");
    const kind = c.req.header("x-gitlab-event");
    const body = c.req.valid("json");
    const mr = kind === "Merge Request Hook" ? gitlabMergeRequest.safeParse(body) : undefined;
    const note = kind === "Note Hook" ? gitlabNote.safeParse(body) : undefined;
    const pipeline = kind === "Pipeline Hook" ? gitlabProject.safeParse(body) : undefined;
    const projectId = mr?.data?.project.id ?? note?.data?.project.id ?? pipeline?.data?.project.id;
    if (projectId === undefined) return c.json({ queued: 0 }, 202);
    const host = new URL(client.url).host;
    const repo = await reviewRepoFor(c.var.db, "gitlab", host, String(projectId));
    const hash = await sha256Hex(token);
    if (!repo?.webhookSecretHash || !sameText(repo.webhookSecretHash, hash)) {
      return apiError(c, "unauthenticated");
    }
    const signal = gitlabSignal(kind, body);
    if (signal) defer(c, moveIntents(runnerOf(c), repo, signal.fullName, signal.signal));
    if (note?.data) {
      return c.json({ queued: await queueGitlabNote(c.var.db, service, repo, note.data) }, 202);
    }
    if (mr) {
      await recordGitlabFlow(c.var.db, repo, body);
      defer(c, tellGitlabHook(c.var.db, publicOutbox(c), repo, body));
    }
    if (mr && (await recordGitlabClose(c.var.db, repo, body))) return c.json({ queued: 0 }, 202);
    const event = mr?.data;
    if (event && gitlabEdited(event.object_attributes)) {
      service.checkPull?.(repo.accountId, repo.id, event.object_attributes.iid);
    }
    if (!event || !gitlabQueues(event.object_attributes)) return c.json({ queued: 0 }, 202);
    const a = event.object_attributes;
    const queued = await queue(c, service, repo, {
      fullName: event.project.path_with_namespace,
      number: a.iid,
      head: a.last_commit.id,
      opened: a.action !== "update",
      facts: {
        ...(a.action === "open" && event.user ? { author: event.user.username } : {}),
        ...(a.target_branch !== undefined ? { baseBranch: a.target_branch } : {}),
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(event.labels ? { labels: event.labels.map((l) => l.title) } : {}),
      },
    });
    return c.json({ queued }, 202);
  });
  return hooks;
}

async function queue(
  c: Context<AppEnv>,
  service: AutoReviewService,
  repo: NonNullable<Awaited<ReturnType<typeof reviewRepoFor>>>,
  change: PullChange,
): Promise<number> {
  if (!COMMIT_ID.test(change.head)) return 0;
  const data = scoped(c.var.db, repo.accountId);
  if (repo.fullName !== change.fullName) {
    await data.update("reviewRepos", repo.id, { fullName: change.fullName });
  }
  const { skipped, run } = await automate(c, data, {
    trigger: "queued",
    eventKey: `${repo.id}#${change.number}@${change.head}`,
    repo: { ...repo, fullName: change.fullName },
    pull: { host: repo.host, fullName: change.fullName, number: change.number },
    facts: { repoId: repo.id, ...change.facts },
    acts: change.opened,
    consoleUrl: new URL("/settings", c.req.url).toString(),
  });
  defer(c, run);
  // A pull request a rule skips the review of still has its checks.
  service.checkPull?.(repo.accountId, repo.id, change.number);
  if (skipped) return 0;
  const queued = await data.autoReview.queue(repo.id, change.number, change.head, new Date());
  if (queued) service.kick();
  return queued ? 1 : 0;
}
