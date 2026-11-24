import { z } from "zod";
import type { PathReader } from "../auto-review/paths.js";
import { githubAskedTeam, gitlabReasked } from "../auto-review/requests.js";
import { teamMembers } from "../auto-review/teams.js";
import type { Db } from "../db/client.js";
import { refreshGithubLogin, refreshGitlabLogin } from "../db/logins.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { teamReviewerId } from "../db/review-teams.js";
import { type Scoped, scoped } from "../db/scoped.js";
import type { BotTokens } from "../platforms/bot.js";
import { plain } from "./channels.js";
import { bySpecificity, githubCommentEvents, gitlabCommentEvents } from "./comment-hooks.js";
import { gitlabGroupAsks, gitlabGroupEvents, gitlabRulesEvent } from "./gitlab-groups.js";
import type { Outbox } from "./notify.js";
import { type EventRepo, ownUser, type PullEvent, tellPullEvent } from "./pull-events.js";
import { keepGithubThread, keepGitlabThread, type StartOf } from "./thread-hooks.js";

// The pull request events of the platforms' webhooks that may concern the
// account's own user (./pull-events.ts): a review asked of them or of a
// team they are on, and on a pull request they wrote, a reviewer's review
// and its merge or close;
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
  requested_team: z.object({ id: z.number(), slug: z.string() }).optional(),
  sender: user.optional(),
  repository: z.object({ id: z.number(), owner: z.object({ login: z.string() }).optional() }),
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

/**
 * The events of a GitHub App webhook's delivery, and the platform's
 * repository id they are of; members, the platform ids of the team a
 * review was asked of. An ask's key is the user's and the pull request's,
 * whoever was asked: tellGithubHook adds the round of review to it.
 */
export function githubPullEvents(
  event: string | undefined,
  body: unknown,
  repoId: string,
  members: readonly string[] | null = null,
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
  const {
    action,
    number,
    pull_request: pull,
    requested_reviewer,
    requested_team,
    sender,
  } = parsed.data;
  const at = pull.updated_at ?? "";
  const org = parsed.data.repository.owner?.login;
  if (action === "review_requested" && requested_team && org && members) {
    const team = plain(`${org}/${requested_team.slug}`);
    return members.map((member) => ({
      kind: "review_requested",
      key: `github:requested:${repoId}#${number}:${member}`,
      number,
      concerns: member,
      by: sender ? id(sender.id) : null,
      what: `${sender ? plain(sender.login) : "Someone"} asked ${team}, a team you are on, for a review`,
      more: titled(pull.title),
    }));
  }
  if (action === "review_requested" && requested_reviewer) {
    return [
      {
        kind: "review_requested",
        key: `github:requested:${repoId}#${number}:${requested_reviewer.id}`,
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
const gitlabReviewer = gitlabUser.extend({
  state: z.string().optional(),
  re_requested: z.boolean().optional(),
});

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
          previous: z.array(gitlabReviewer).nullish(),
          current: z.array(gitlabReviewer).nullish(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * The events of a GitLab merge request hook, for the enrolled repository it
 * proved. A reviewer asked again has the key of their first ask:
 * tellGitlabHook adds the round, which their answer ended.
 */
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
      key: `gitlab:requested:${repoId}#${a.iid}:${u.id}`,
      concerns: id(u.id),
      what: `${who} asked for your review`,
    }));
  for (const r of gitlabReasked(changes)) {
    events.push({
      ...base,
      kind: "review_requested",
      key: `gitlab:requested:${repoId}#${a.iid}:${r.id}`,
      concerns: id(r.id),
      what: `${who} asked for your review again`,
    });
  }
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

const githubRepoId = z.object({ repository: z.object({ id: z.number() }) });
const githubSender = z.object({ sender: user });
const gitlabActor = z.object({ user: gitlabUser });

/** Every part of a GitHub delivery that tellGithubHook reads, beside the conversation's (./comment-hooks.ts, ./thread-hooks.ts). */
export const GITHUB_HOOK_FIELDS = [githubPullEvent, githubReviewEvent, githubRepoId, githubSender];
/** Every part of a GitLab merge request hook that tellGitlabHook reads. */
export const GITLAB_HOOK_FIELDS = [gitlabEvent, gitlabActor, gitlabRulesEvent];

const quick = new Set([
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "pull_request_review_comment",
]);

/** Tells the enrolled repository's account of a GitHub delivery's events that are its own. */
export async function tellGithubHook(
  db: Db,
  host: string,
  out: Outbox,
  event: string | undefined,
  body: unknown,
  bots?: BotTokens,
): Promise<number> {
  if (!event || !quick.has(event)) return 0;
  const repoId = githubRepoId.safeParse(body);
  if (!repoId.success) return 0;
  const repo = await reviewRepoFor(db, "github", host, id(repoId.data.repository.id));
  if (!repo) return 0;
  const sender = githubSender.safeParse(body);
  if (sender.success) {
    await refreshGithubLogin(db, {
      id: id(sender.data.sender.id),
      login: sender.data.sender.login,
    });
  }
  const data = scoped(db, repo.accountId);
  const team = event === "pull_request" ? githubAskedTeam(body) : null;
  const read = bots?.teamMembers;
  const members = team?.asked
    ? await teamMembers(data, read ? () => read(team.org, team.slug) : null, {
        platform: "github",
        host,
        reviewerId: teamReviewerId(team.id),
        name: `${team.org}/${team.slug}`,
      })
    : null;
  const asks = githubPullEvents(event, body, repo.id, members);
  const events = bySpecificity([
    ...(await inRound(db, data, repo, asks, githubAskedAt(body))),
    ...githubCommentEvents(event, body, repo.id),
    ...(await keepGithubThread(data, event, body, repo.id)),
  ]);
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, data, out, repo, events)).length;
}

/**
 * The account's user's asks of a review, each keyed by their round of
 * review on the pull request: asked of them and of a team they are on, or
 * of two teams, the channel's claim of that one key tells them once,
 * whichever comes first. The round ends when the ask of them or of the
 * team does (a review, a removal), so an ask after it tells them again;
 * an ask from before it, delivered late or again, tells nobody.
 */
/** When a GitHub delivery says its pull request changed; NaN when it does not. */
function githubAskedAt(body: unknown): number {
  const parsed = githubPullEvent.safeParse(body);
  return Date.parse(parsed.success ? (parsed.data.pull_request.updated_at ?? "") : "");
}

async function inRound(
  db: Db,
  data: Scoped,
  repo: EventRepo,
  events: readonly PullEvent[],
  at: number,
): Promise<PullEvent[]> {
  if (!events.some((e) => e.kind === "review_requested")) return [...events];
  const me = await ownUser(db, data, repo);
  const kept: PullEvent[] = [];
  for (const e of events) {
    if (e.kind !== "review_requested") kept.push(e);
    else if (me && e.concerns === me.id) {
      const round = await data.reviewRequests.roundOf(
        { platform: repo.platform, host: repo.host, userId: me.id },
        repo.id,
        e.number,
      );
      if (Number.isNaN(at) || at > round) kept.push({ ...e, key: `${e.key}@${round}` });
    }
  }
  return kept;
}

/** When a GitLab hook says its merge request changed; NaN when it does not. */
function gitlabAskedAt(body: unknown): number {
  const parsed = gitlabEvent.safeParse(body);
  return Date.parse(parsed.success ? (parsed.data.object_attributes.updated_at ?? "") : "");
}

/** Keeps the login on record of the GitLab user the hook shows acting. */
async function refreshGitlabActor(db: Db, host: string, body: unknown) {
  const actor = gitlabActor.safeParse(body);
  if (!actor.success) return;
  const { id: userId, username } = actor.data.user;
  await refreshGitlabLogin(db, host, { id: id(userId), login: username });
}

/** Tells the account of a GitLab merge request hook's events that are its own. */
export async function tellGitlabHook(
  db: Db,
  out: Outbox,
  repo: EventRepo & { accountId: string },
  body: unknown,
  reader?: PathReader,
): Promise<number> {
  await refreshGitlabActor(db, repo.host, body);
  const data = scoped(db, repo.accountId);
  const groups = reader
    ? await gitlabGroupEvents(data, repo, body, gitlabGroupAsks(reader, repo))
    : [];
  const events = [
    ...(await inRound(db, data, repo, gitlabPullEvents(body, repo.id), gitlabAskedAt(body))),
    // A group's notice is made only while its ask waits, read just now: no delivery is late.
    ...(await inRound(db, data, repo, groups, Number.NaN)),
  ];
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, data, out, repo, events)).length;
}

/** Tells the account of a GitLab note hook's events that are its own. */
export async function tellGitlabNote(
  db: Db,
  out: Outbox,
  repo: EventRepo & { accountId: string },
  body: unknown,
  startOf?: StartOf,
): Promise<number> {
  await refreshGitlabActor(db, repo.host, body);
  const data = scoped(db, repo.accountId);
  const events = bySpecificity([
    ...gitlabCommentEvents(body, repo.id),
    ...(await keepGitlabThread(data, body, repo.id, startOf)),
  ]);
  if (events.length === 0) return 0;
  return (await tellPullEvent(db, data, out, repo, events)).length;
}
