import { z } from "zod";
import { isBotLogin } from "../platforms/reviewers.js";
import { plain } from "./channels.js";
import { excerptOf, mentionsOf } from "./mentions.js";
import type { PullEvent } from "./pull-events.js";

// The pull request conversation's events (./pull-events.ts): a comment by
// someone else on a pull request the user wrote (pull_commented), and a
// comment or review that @-mentions the user's login (mentioned). A bot's
// comment tells nobody, ocra's own included. The events of one comment
// share its key, and so do the comments of one GitHub review with the
// review itself, so a review with five inline comments is one notice.
// Comment text goes out only as a short plain excerpt, and is never logged.

const user = z.object({ id: z.number(), login: z.string(), type: z.string().optional() });
type User = z.infer<typeof user>;
const isBot = (u: User) => u.type === "Bot" || isBotLogin(u.login);

const githubIssueComment = z.object({
  action: z.literal("created"),
  issue: z.object({
    number: z.number().int().min(1),
    title: z.string(),
    user: user.optional(),
    pull_request: z.object({}).loose(),
  }),
  comment: z.object({ id: z.number(), body: z.string(), user }),
});

const githubReviewComment = z.object({
  action: z.literal("created"),
  pull_request: z.object({
    number: z.number().int().min(1),
    title: z.string(),
    user: user.optional(),
  }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    user,
    pull_request_review_id: z.number().nullish(),
  }),
});

const githubReview = z.object({
  action: z.literal("submitted"),
  pull_request: z.object({
    number: z.number().int().min(1),
    title: z.string(),
    user: user.optional(),
  }),
  review: z.object({
    id: z.number(),
    body: z.string().nullish(),
    user: user.nullable(),
    state: z.string(),
  }),
});

type Comment = {
  number: number;
  title: string;
  /** The platform's id of the pull request's author, when it says it. */
  author?: string;
  by: { id: string; login: string };
  body: string;
  /** The key of its mention, and of the notice to the author. */
  mentionKey: string;
  commentKey: string;
  /** Whether the author hears of it as a comment; a review tells them as pull_reviewed already. */
  toAuthor: boolean;
  noun: "pull request" | "merge request";
};

function commentEvents(c: Comment): PullEvent[] {
  const excerpt = excerptOf(c.body);
  const more = [plain(c.title), ...(excerpt ? [`“${excerpt}”`] : [])];
  const who = plain(c.by.login);
  const base = { number: c.number, by: c.by.id, more };
  const events: PullEvent[] = [];
  const mentions = mentionsOf(c.body);
  if (mentions.length > 0) {
    events.push({
      ...base,
      kind: "mentioned",
      key: c.mentionKey,
      mentions,
      what: `${who} mentioned you`,
    });
  }
  if (c.toAuthor && c.author !== undefined) {
    events.push({
      ...base,
      kind: "pull_commented",
      key: c.commentKey,
      concerns: c.author,
      what: `${who} commented on your ${c.noun}`,
    });
  }
  return events;
}

const author = (u: User | undefined) => (u ? { author: String(u.id) } : {});
const by = (u: User) => ({ id: String(u.id), login: u.login });

/** The conversation events of a GitHub App delivery, for the enrolled repository's id. */
export function githubCommentEvents(
  event: string | undefined,
  body: unknown,
  repoId: string,
): PullEvent[] {
  const github = { noun: "pull request" as const };
  if (event === "issue_comment") {
    const parsed = githubIssueComment.safeParse(body);
    if (!parsed.success || isBot(parsed.data.comment.user)) return [];
    const { issue, comment } = parsed.data;
    const key = `github:comment:${repoId}:${comment.id}`;
    return commentEvents({
      ...github,
      number: issue.number,
      title: issue.title,
      ...author(issue.user),
      by: by(comment.user),
      body: comment.body,
      mentionKey: key,
      commentKey: key,
      toAuthor: true,
    });
  }
  if (event === "pull_request_review_comment") {
    const parsed = githubReviewComment.safeParse(body);
    if (!parsed.success || isBot(parsed.data.comment.user)) return [];
    const { pull_request: pull, comment } = parsed.data;
    const review = comment.pull_request_review_id;
    return commentEvents({
      ...github,
      number: pull.number,
      title: pull.title,
      ...author(pull.user),
      by: by(comment.user),
      body: comment.body,
      mentionKey: `github:comment:${repoId}:${comment.id}`,
      commentKey: review
        ? `github:review:${repoId}:${review}`
        : `github:comment:${repoId}:${comment.id}`,
      toAuthor: true,
    });
  }
  if (event === "pull_request_review") {
    const parsed = githubReview.safeParse(body);
    if (!parsed.success) return [];
    const { pull_request: pull, review } = parsed.data;
    if (!review.user || isBot(review.user) || !review.body?.trim()) return [];
    // The same key as the review's pull_reviewed notice: one of them goes.
    const key = `github:review:${repoId}:${review.id}`;
    return commentEvents({
      ...github,
      number: pull.number,
      title: pull.title,
      ...author(pull.user),
      by: by(review.user),
      body: review.body,
      mentionKey: key,
      commentKey: key,
      toAuthor: review.state.toLowerCase() === "commented",
    });
  }
  return [];
}

const gitlabNote = z.object({
  user: z.object({ id: z.number(), username: z.string(), bot: z.boolean().optional() }),
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.literal("MergeRequest"),
    system: z.boolean().nullish(),
  }),
  merge_request: z.object({
    iid: z.number().int().min(1),
    title: z.string(),
    author_id: z.number().optional(),
  }),
});

/** The conversation events of a GitLab note hook, for the enrolled repository it proved. */
export function gitlabCommentEvents(body: unknown, repoId: string): PullEvent[] {
  const parsed = gitlabNote.safeParse(body);
  if (!parsed.success) return [];
  const { user: u, object_attributes: note, merge_request: mr } = parsed.data;
  if (u.bot || isBotLogin(u.username) || note.system) return [];
  const key = `gitlab:note:${repoId}:${note.id}`;
  return commentEvents({
    noun: "merge request",
    number: mr.iid,
    title: mr.title,
    ...(mr.author_id !== undefined ? { author: String(mr.author_id) } : {}),
    by: { id: String(u.id), login: u.username },
    body: note.note,
    mentionKey: key,
    commentKey: key,
    toAuthor: true,
  });
}

/** Events in the order a channel hears of one: a mention, then the rest, a comment last. */
export function bySpecificity(events: PullEvent[]): PullEvent[] {
  const rank = (e: PullEvent) => (e.kind === "mentioned" ? 0 : e.kind === "pull_commented" ? 2 : 1);
  return [...events].sort((a, b) => rank(a) - rank(b));
}
