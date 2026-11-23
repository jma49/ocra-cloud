import { z } from "zod";
import type { Scoped } from "../db/scoped.js";
import type { DiscussionStart } from "../platforms/gitlab-discussion.js";
import { isBotLogin } from "../platforms/reviewers.js";
import { plain } from "./channels.js";
import { isBot, user } from "./comment-hooks.js";
import { excerptOf } from "./mentions.js";
import type { PullEvent } from "./pull-events.js";

// Who started each review thread of an enrolled repository's pull requests,
// kept from its webhooks (src/db/review-threads.ts), and the thread_replied
// event of a reply by someone else. On GitHub a review comment with no
// in_reply_to_id starts its thread, and a reply names the thread's first
// comment. A GitLab note names its discussion but not whether it is the
// first note: a plain comment (a note with no type) opens its own; a diff
// or discussion note of a discussion not on record is looked up once
// (./gitlab-starts.ts) and its first note kept as the start, never guessed
// at. A thread whose start is not found, or was a bot's, is not on record,
// and a reply in it tells nobody. A bot's
// reply is not kept. The event shares its comment's key, so the comment is
// one notice; comment text goes out only as a plain excerpt, never logged.

/** A platform clock this far ahead of ours is taken as ours. */
const SKEW_MS = 5 * 60 * 1000;

type ThreadNote = {
  number: number;
  title: string;
  threadKey: string;
  noteId: string;
  /** Whether the note starts its thread; else it replies in one, which may not be on record. */
  starts: boolean;
  by: { id: string; login: string };
  at: Date;
  body: string;
  key: string;
  noun: "pull request" | "merge request";
};

export function timeOf(raw: string | null | undefined, now: Date): Date {
  const at = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(at) || at > now.getTime() + SKEW_MS ? now : new Date(at);
}

const githubReviewComment = z.object({
  action: z.literal("created"),
  pull_request: z.object({ number: z.number().int().min(1), title: z.string() }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    user,
    created_at: z.string().nullish(),
    in_reply_to_id: z.number().nullish(),
    pull_request_review_id: z.number().nullish(),
  }),
});

function githubNote(event: string | undefined, body: unknown, repoId: string, now: Date) {
  if (event !== "pull_request_review_comment") return null;
  const parsed = githubReviewComment.safeParse(body);
  if (!parsed.success || isBot(parsed.data.comment.user)) return null;
  const { pull_request: pull, comment: c } = parsed.data;
  const review = c.pull_request_review_id;
  return {
    number: pull.number,
    title: pull.title,
    threadKey: String(c.in_reply_to_id ?? c.id),
    noteId: String(c.id),
    starts: c.in_reply_to_id == null,
    by: { id: String(c.user.id), login: c.user.login },
    at: timeOf(c.created_at, now),
    body: c.body,
    // The key of its comment notice (./comment-hooks.ts).
    key: review ? `github:review:${repoId}:${review}` : `github:comment:${repoId}:${c.id}`,
    noun: "pull request",
  } satisfies ThreadNote;
}

const gitlabNote = z.object({
  user: z.object({ id: z.number(), username: z.string(), bot: z.boolean().optional() }),
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.literal("MergeRequest"),
    system: z.boolean().nullish(),
    type: z.string().nullish(),
    discussion_id: z.string().min(1).max(64),
    created_at: z.string().nullish(),
  }),
  merge_request: z.object({ iid: z.number().int().min(1), title: z.string() }),
});

function gitlabThreadNote(body: unknown, repoId: string, now: Date) {
  const parsed = gitlabNote.safeParse(body);
  if (!parsed.success) return null;
  const { user: u, object_attributes: n, merge_request: mr } = parsed.data;
  if (u.bot || isBotLogin(u.username) || n.system) return null;
  return {
    number: mr.iid,
    title: mr.title,
    threadKey: n.discussion_id,
    noteId: String(n.id),
    starts: n.type == null,
    by: { id: String(u.id), login: u.username },
    at: timeOf(n.created_at, now),
    body: n.note,
    key: `gitlab:note:${repoId}:${n.id}`,
    noun: "merge request",
  } satisfies ThreadNote;
}

/** Every part of a delivery that a review thread's start or reply reads. */
export const GITHUB_THREAD_FIELDS = [githubReviewComment];
export const GITLAB_THREAD_FIELDS = [gitlabNote];

/** The first note of a merge request's discussion, from the platform; null when it does not say. */
export type StartOf = (number: number, threadKey: string) => Promise<DiscussionStart | null>;

/** Keeps the note's start or reply; the thread_replied event of a reply by someone other than the starter. */
async function keep(
  data: Scoped,
  reviewRepoId: string,
  note: ThreadNote | null,
  now: Date,
  startOf?: StartOf,
): Promise<PullEvent[]> {
  if (!note) return [];
  const start = (by: ThreadNote["by"], at: Date) =>
    data.reviewThreads.start(
      {
        reviewRepoId,
        number: note.number,
        threadKey: note.threadKey,
        starterId: by.id,
        starterLogin: by.login,
        startedAt: at,
      },
      now,
    );
  if (note.starts) {
    await start(note.by, note.at);
    return [];
  }
  const reply = { reviewRepoId, threadKey: note.threadKey, byId: note.by.id, at: note.at };
  let thread = await data.reviewThreads.reply(reply, now);
  if (!thread && startOf) {
    const first = await startOf(note.number, note.threadKey);
    if (!first || first.system || isBotLogin(first.login)) return [];
    await start({ id: first.authorId, login: first.login }, timeOf(first.createdAt, now));
    if (first.noteId === note.noteId) return [];
    thread = await data.reviewThreads.reply(reply, now);
  }
  if (!thread) return [];
  if (thread.starterId === note.by.id) return [];
  const excerpt = excerptOf(note.body);
  return [
    {
      kind: "thread_replied",
      key: note.key,
      number: thread.number,
      concerns: thread.starterId,
      by: note.by.id,
      what: `${plain(note.by.login)} replied in your review thread`,
      more: [plain(note.title), ...(excerpt ? [`“${excerpt}”`] : [])],
    },
  ];
}

/** Keeps a GitHub delivery's review thread start or reply; its thread_replied event. */
export function keepGithubThread(
  data: Scoped,
  event: string | undefined,
  body: unknown,
  reviewRepoId: string,
  now = new Date(),
): Promise<PullEvent[]> {
  return keep(data, reviewRepoId, githubNote(event, body, reviewRepoId, now), now);
}

/**
 * Keeps a GitLab note hook's discussion start or reply; its thread_replied
 * event. `startOf` looks up the start of a discussion not on record.
 */
export function keepGitlabThread(
  data: Scoped,
  body: unknown,
  reviewRepoId: string,
  startOf?: StartOf,
  now = new Date(),
): Promise<PullEvent[]> {
  return keep(data, reviewRepoId, gitlabThreadNote(body, reviewRepoId, now), now, startOf);
}
