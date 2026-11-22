import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { plain } from "./channels.js";
import { bySpecificity, githubCommentEvents, gitlabCommentEvents } from "./comment-hooks.js";
import type { Outbox } from "./notify.js";
import { type EventRepo, type PullEvent, tellPullEvent } from "./pull-events.js";
import { keepGithubThread, keepGitlabThread, type StartOf } from "./thread-hooks.js";

// The pull request events of the platforms' webhooks that may concern the
// account's own user (./pull-events.ts): a review asked of them, and on a
// pull request they wrote, a reviewer's review and its merge or close;
// and the conversation's comments and mentions (./comment-hooks.ts), and
// replies in review threads the user started (./thread-hooks.ts), whose
// starts and replies are kept whether or not a channel hears of them.
// Read after the webhook is answered. A key is made of what a redelivery
// repeats: the platform's review id, or the time it wrote for the change.

const user = z.object({ id: z.number(), login: z.string(), type: z.string().optional() });
const isBot = (u: z.infer<typeof user>) => u.type === "Bot" || u.login.endsWith("[bot]");

const githubPull = z.object({
  title: z.string(),
  user: user.optional(),
  merged: z.boolean().optional(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});

const githubPullEvent = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: githubPull,
  requested_reviewer: user.optional(),
  sender: user.optional(),
  repository: z.object({ id: z.number() }),
});

const githubReviewEvent = z.object({
  action: z.literal("submitted"),
  review: z.object({
    id: z.number(),
    user: user.nullable(),
    state: z.string(),
    body: z.string().nullish(),
  }),
  pull_request: githubPull.extend({ number: z.number().int().min(1) }),
  repository: z.object({ id: z.number() }),
});

const REVIEWED: Record<string, string> = {
  approved: "approved your pull request",
  changes_requested: "requested changes on your pull request",
  commented: "commented on your pull request",
};

const titled = (title: string) => [plain(title)];
const id = (n: number) => String(n);

/** The events of a GitHub App webhook's delivery, and the platform's repository id they are of. */
export function githubPullEvents(
  event: string | undefined,
  body: unknown,
  repoId: string,
): PullEvent[] {
  if (event === "pull_request_review") {
    const parsed = githubReviewEvent.safeParse(body);
    if (!parsed.success) return [];
    const { review, pull_request: pull } = parsed.data;
    const what = REVIEWED[review.state.toLowerCase()];
    const author = pull.user;
    if (!what || !review.user || !author || isBot(review.user)) return [];
    // A reply in a thread is a review with no text of its own.
    if (review.state.toLowerCase() === "commented" && !review.body?.trim()) return [];
    return [
      {
        kind: "pull_reviewed",
        key: `github:review:${repoId}:${review.id}`,
        number: pull.number,
        concerns: id(author.id),
        by: id(review.user.id),
        what: `${plain(review.user.login)} ${what}`,
        more: titled(pull.title),
      },
    ];
  }
  if (event !== "pull_request") return [];
  const parsed = githubPullEvent.safeParse(body);
  if (!parsed.success) return [];
  const { action, number, pull_request: pull, requested_reviewer, sender } = parsed.data;
  const at = pull.updated_at ?? "";
  if (action === "review_requested" && requested_reviewer) {
    return [
      {
        kind: "review_requested",
        key: `github:requested:${repoId}#${number}:${requested_reviewer.id}:${at}`,
        number,
        concerns: id(requested_reviewer.id),
        by: sender ? id(sender.id) : null,
        what: `${sender ? plain(sender.login) : "Someone"} asked for your review`,
        more: titled(pull.title),
      },
    ];
  }
  if (action === "closed" && pull.user) {
    const merged = pull.merged === true;
    return [
      {
        kind: "pull_closed",
        key: `github:closed:${repoId}#${number}:${pull.closed_at ?? at}`,
        number,
        concerns: id(pull.user.id),
        by: sender ? id(sender.id) : null,
        what: `Your pull request was ${merged ? "merged" : "closed"}${sender ? ` by ${plain(sender.login)}` : ""}`,
        more: titled(pull.title),
      },
    ];
  }
  return [];
}

const gitlabUser = z.object({ id: z.number(), username: z.string() });

const gitlabEvent = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    title: z.string(),
    author_id: z.number().optional(),
    updated_at: z.string().nullish(),
  }),
  user: gitlabUser.optional(),
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

/** The events of a GitLab merge request hook, for the enrolled repository it proved. */
export function gitlabPullEvents(body: unknown, repoId: string): PullEvent[] {
  const parsed = gitlabEvent.safeParse(body);
  if (!parsed.success) return [];
  const { object_attributes: a, user: by, changes } = parsed.data;
  const at = a.updated_at ?? "";
  const base = { number: a.iid, by: by ? id(by.id) : null, more: titled(a.title) };
  const who = by ? plain(by.username) : "Someone";
  const before = new Set((changes?.reviewers?.previous ?? []).map((u) => u.id));
  const events: PullEvent[] = (changes?.reviewers?.current ?? [])
    .filter((u) => !before.has(u.id))
    .map((u) => ({
      ...base,
      kind: "review_requested",
      key: `gitlab:requested:${repoId}#${a.iid}:${u.id}:${at}`,
      concerns: id(u.id),
      what: `${who} asked for your review`,
    }));
  if (a.author_id === undefined) return events;
  const author = id(a.author_id);
  if (a.action === "approved" || a.action === "approval") {
    events.push({
      ...base,
      kind: "pull_reviewed",
      key: `gitlab:approved:${repoId}#${a.iid}:${by?.id ?? ""}:${at}`,
      concerns: author,
      what: `${who} approved your merge request`,
    });
  }
  if (a.action === "merge" || a.action === "close") {
    events.push({
      ...base,
      kind: "pull_closed",
      key: `gitlab:closed:${repoId}#${a.iid}:${at}`,
      concerns: author,
      what: `Your merge request was ${a.action === "merge" ? "merged" : "closed"} by ${who}`,
    });
  }
  return events;
}

const quick = new Set([
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "pull_request_review_comment",
]);

/** Tells the enrolled repository's account of a GitHub delivery's events that are its own. */
export async function tellGithubHook(
  db: Db,
  out: Outbox,
  event: string | undefined,
  body: unknown,
): Promise<number> {
  if (!event || !quick.has(event)) return 0;
  const repoId = z.object({ repository: z.object({ id: z.number() }) }).safeParse(body);
  if (!repoId.success) return 0;
  const repo = await reviewRepoFor(db, "github", "github.com", id(repoId.data.repository.id));
  if (!repo) return 0;
  const data = scoped(db, repo.accountId);
  const events = bySpecificity([
    ...githubPullEvents(event, body, repo.id),
    ...githubCommentEvents(event, body, repo.id),
    ...(await keepGithubThread(data, event, body, repo.id)),
  ]);
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, data, out, repo, events)).length;
}

/** Tells the account of a GitLab merge request hook's events that are its own. */
export async function tellGitlabHook(
  db: Db,
  out: Outbox,
  repo: EventRepo & { accountId: string },
  body: unknown,
): Promise<number> {
  const events = gitlabPullEvents(body, repo.id);
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, scoped(db, repo.accountId), out, repo, events)).length;
}

/** Tells the account of a GitLab note hook's events that are its own. */
export async function tellGitlabNote(
  db: Db,
  out: Outbox,
  repo: EventRepo & { accountId: string },
  body: unknown,
  startOf?: StartOf,
): Promise<number> {
  const data = scoped(db, repo.accountId);
  const events = bySpecificity([
    ...gitlabCommentEvents(body, repo.id),
    ...(await keepGitlabThread(data, body, repo.id, startOf)),
  ]);
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, data, out, repo, events)).length;
}
