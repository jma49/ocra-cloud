import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Scoped, scoped } from "../db/scoped.js";
import { plain } from "./channels.js";
import type { Outbox } from "./notify.js";
import { type EventRepo, tellPullEvent } from "./pull-events.js";

// The repository's own CI failing on a pull request's head: a GitHub check
// suite that completed as a failure, of an App other than ocra's (whose
// pre-merge check tells its author itself, ./pull-events.ts), or a GitLab
// merge request pipeline that failed. Told to the pull request's author
// only, once per head: a later run on that head, green or red, tells
// nothing. Read from the delivery's fields when it arrives, never from the
// platform, so it costs no call.

/** What a delivery says failed: its head, and the pull requests of it. */
export type CiFailure = { head: string; numbers: number[] };

/** Pull requests of one head told at once, of one delivery. */
const MAX_PULLS = 5;

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const githubSuite = z.object({
  action: z.literal("completed"),
  check_suite: z.object({
    head_sha: sha,
    conclusion: z.string().nullable(),
    app: z.object({ id: z.number().int() }).nullish(),
    pull_requests: z.array(
      z.object({ number: z.number().int().min(1), head: z.object({ sha: z.string() }) }),
    ),
  }),
});

/** A GitHub check suite delivery's failure; null when it says none, or is ocra's own App's. */
export function githubCiFailure(
  event: string | undefined,
  body: unknown,
  ownAppId: string | undefined,
): CiFailure | null {
  if (event !== "check_suite") return null;
  const parsed = githubSuite.safeParse(body);
  if (!parsed.success) return null;
  const suite = parsed.data.check_suite;
  if (!FAILED.has(suite.conclusion ?? "")) return null;
  if (ownAppId !== undefined && suite.app?.id === Number(ownAppId)) return null;
  // A pull request whose head moved on is listed under its old head no more.
  const numbers = suite.pull_requests
    .filter((p) => p.head.sha === suite.head_sha)
    .map((p) => p.number)
    .slice(0, MAX_PULLS);
  return numbers.length > 0 ? { head: suite.head_sha, numbers } : null;
}

const gitlabPipeline = z.object({
  object_attributes: z.object({ sha, status: z.string() }),
  merge_request: z.object({ iid: z.number().int().min(1), state: z.string() }).nullish(),
});

/** A GitLab pipeline hook's failure, of an open merge request's pipeline; null otherwise. */
export function gitlabCiFailure(kind: string | undefined, body: unknown): CiFailure | null {
  if (kind !== "Pipeline Hook") return null;
  const parsed = gitlabPipeline.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: a, merge_request: mr } = parsed.data;
  if (a.status !== "failed" || !mr || mr.state !== "opened") return null;
  return { head: a.sha, numbers: [mr.iid] };
}

/** The author's id and title of a pull request the console holds open; null for one closed. */
async function openPull(data: Scoped, repoId: string, number: number) {
  const flow = await data.findOne("pullFlows", { reviewRepoId: repoId, number });
  if (!flow?.authorId) return null;
  const closed = await data.findOne("closedPulls", { reviewRepoId: repoId, number });
  if (closed && !(flow.reopenedAt && closed.closedAt < flow.reopenedAt)) return null;
  return { authorId: flow.authorId, title: flow.title };
}

/** Tells each failed pull request's author, once per head; the channels it went to. */
export async function tellCiFailed(
  db: Db,
  data: Scoped,
  out: Outbox,
  repo: EventRepo,
  failure: CiFailure,
): Promise<string[]> {
  const told: string[] = [];
  const pull = repo.platform === "gitlab" ? "merge request" : "pull request";
  for (const number of failure.numbers.slice(0, MAX_PULLS)) {
    const open = await openPull(data, repo.id, number);
    if (!open) continue;
    const sent = await tellPullEvent(db, data, out, repo, [
      {
        kind: "checks_failed",
        key: `ci:${repo.id}#${number}@${failure.head}`,
        number,
        concerns: open.authorId,
        what: `CI failed on your ${pull}`,
        more: [plain(open.title)],
      },
    ]);
    told.push(...sent);
  }
  return told;
}

/** A GitHub delivery's failure, as its record kept it, for its enrolled repository. */
export async function tellGithubCi(
  db: Db,
  host: string,
  out: Outbox,
  platformRepoId: string,
  failure: CiFailure,
): Promise<string[]> {
  const repo = await reviewRepoFor(db, "github", host, platformRepoId);
  if (!repo) return [];
  return tellCiFailed(db, scoped(db, repo.accountId), out, repo, failure);
}
