import { githubIdOf } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import type { Row, Scoped } from "../db/scoped.js";
import { consolePullUrl } from "../merge-checks/run.js";
import type { CodePlatform } from "../platforms/platform.js";
import { pullOfReview, pullOnPlatform } from "../review-pull.js";
import type { NotifyEvent } from "../shared/index.js";
import { type Message, plain } from "./channels.js";
import { type Outbox, send } from "./notify.js";

// Telling the account about an event of an enrolled repository's pull
// request that concerns its own platform user: known by the platform's id
// of that user (the GitHub identity it signs in with, the user of its
// GitLab link), never by a login. Each subscribed channel claims the
// event's key before its message goes, so a webhook delivered twice, or
// two processes, tell it once; a message that fails is not sent again.

export type EventRepo = Pick<Row<"reviewRepos">, "id" | "platform" | "host" | "fullName">;

/** A pull request event, before it is known to be the account's own. */
export type PullEvent = {
  kind: NotifyEvent;
  /** The event itself: a redelivery of it has the same key. */
  key: string;
  number: number;
  /** The platform's id of the user it concerns: the reviewer asked, or the author. */
  concerns: string;
  /** The platform's id of who did it; an event the user caused tells nobody. */
  by?: string | null;
  /** What happened, said to the user: plain text, never a finding's. */
  what: string;
  /** Lines after it: the platform's title, finding titles when shared. */
  more?: string[];
};

/** The platform's id of the account's own user there; null when it has none on record. */
async function ownUserId(db: Db, data: Scoped, repo: EventRepo): Promise<string | null> {
  if (repo.platform === "github") {
    if (repo.host !== "github.com") return null;
    const id = await githubIdOf(db, data.accountId);
    return id === null ? null : String(id);
  }
  const link = await data.findOne("platformLinks", { platform: repo.platform, host: repo.host });
  return link?.userId ?? null;
}

function pullEventMessage(repo: EventRepo, e: PullEvent, origin: string): Message {
  const label = `${repo.fullName}#${e.number}`;
  const url = consolePullUrl(origin, repo, e.number);
  return {
    subject: `ocra: ${e.what} (${label})`,
    lines: [
      [`${e.what}: `, { label, url }],
      ...(e.more ?? []).map((line) => [line]),
      [{ label: "Open in ocra", url }],
    ],
  };
}

/**
 * Tells each channel that hears about the event; the ids of those it went
 * to. Nothing is read past the channels when none hears about it.
 */
export async function tellPullEvent(
  db: Db,
  data: Scoped,
  out: Outbox,
  repo: EventRepo,
  events: readonly PullEvent[],
): Promise<string[]> {
  const kinds = [...new Set(events.map((e) => e.kind))];
  const heard = new Map<NotifyEvent, Row<"notifyChannels">[]>();
  for (const kind of kinds) {
    const channels = await data.notify.subscribed(kind);
    if (channels.length > 0) heard.set(kind, channels);
  }
  if (heard.size === 0) return [];
  const me = await ownUserId(db, data, repo);
  if (me === null) return [];
  const told: string[] = [];
  for (const e of events) {
    const channels = heard.get(e.kind);
    if (!channels || e.concerns !== me || e.by === me) continue;
    const m = pullEventMessage(repo, e, out.origin);
    await Promise.all(
      channels.map(async (ch) => {
        if (!(await data.notify.claimSend(ch.id, e.key))) return;
        told.push(ch.id);
        await send(data, out, ch, m);
      }),
    );
  }
  return told;
}

/** The author's id of the pull request, as its webhooks recorded it. */
async function authorIdOf(data: Scoped, repoId: string, number: number) {
  const flow = await data.findOne("pullFlows", { reviewRepoId: repoId, number });
  return flow?.authorId ?? null;
}

/** Tells the author that the pull request's checks failed on head, once per head. */
export async function tellChecksFailed(
  db: Db,
  data: Scoped,
  out: Outbox,
  repo: EventRepo,
  pull: { number: number; head: string; summary: string },
): Promise<string[]> {
  const author = await authorIdOf(data, repo.id, pull.number);
  if (author === null) return [];
  return tellPullEvent(db, data, out, repo, [
    {
      kind: "checks_failed",
      key: `checks:${repo.id}#${pull.number}@${pull.head}`,
      number: pull.number,
      concerns: author,
      what: "Pre-merge checks failed on your pull request",
      more: [pull.summary],
    },
  ]);
}

/**
 * Tells the author of the reviewed pull request, on a repository the
 * account enrolled, that ocra's review found a critical finding; finding
 * titles only when the account shares findings. The channels it went to
 * are left out of the review's own announcement.
 */
export async function tellReviewBlocking(
  db: Db,
  data: Scoped,
  out: Outbox,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  shareFindings: boolean,
): Promise<string[]> {
  if (review.critical === 0) return [];
  const reviewed = pullOfReview(review);
  const on = reviewed && pullOnPlatform(platforms, reviewed);
  if (!on) return [];
  const repo = await data.mergeChecks.enrolledRepo(
    on.platform.kind,
    on.platform.host,
    on.pull.repo,
  );
  if (!repo) return [];
  const author = await authorIdOf(data, repo.id, on.pull.number);
  if (author === null) return [];
  const titles = shareFindings
    ? (await data.findingsOf(review.id))
        .filter((f) => f.severity === "critical")
        .slice(0, 3)
        .map((f) => `• ${plain(f.title)} (${plain(f.file)})`)
    : [];
  const found = `${review.critical} critical finding${review.critical === 1 ? "" : "s"}`;
  return tellPullEvent(db, data, out, repo, [
    {
      kind: "review_blocking",
      key: `review:${review.id}`,
      number: on.pull.number,
      concerns: author,
      what: `ocra found ${found} in your pull request`,
      more: titles,
    },
  ]);
}

/** Tells the account's own user of an event of theirs, such as how a merge they armed ended. */
export async function tellOwnPullEvent(
  db: Db,
  data: Scoped,
  out: Outbox,
  repo: EventRepo,
  event: Omit<PullEvent, "concerns" | "by">,
): Promise<string[]> {
  if ((await data.notify.subscribed(event.kind)).length === 0) return [];
  const me = await ownUserId(db, data, repo);
  if (me === null) return [];
  return tellPullEvent(db, data, out, repo, [{ ...event, concerns: me }]);
}
