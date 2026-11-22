import { z } from "zod";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import type { AppEnv } from "../types.js";
import type { AutoReviewService } from "./routes.js";

// A comment that mentions @ocra on an enrolled repository's pull request
// queues an answer (`ocra reply`), once per comment. The CLI decides whether
// it is a question it answers; a bot's comment is never queued, so two bots
// cannot talk to each other through the queue.

type Db = AppEnv["Variables"]["db"];

const MENTION = /@ocra\b/i;
const MAX_ID = 10_000_000_000_000;

const id = z.number().int().min(1).lt(MAX_ID);
const githubComment = z.object({
  action: z.literal("created"),
  comment: z.object({ id, body: z.string(), user: z.object({ type: z.string() }) }),
  repository: z.object({ id: z.number(), full_name: z.string() }),
  // issue_comment names the pull request as an issue with pull_request set.
  issue: z.object({ number: id, pull_request: z.object({}).loose() }).optional(),
  pull_request: z.object({ number: id }).optional(),
});

/** A GitHub App webhook's issue_comment or pull_request_review_comment (src/webhooks.ts verified it). */
export async function queueGithubComment(
  db: Db,
  service: AutoReviewService,
  event: "issue_comment" | "pull_request_review_comment",
  body: unknown,
): Promise<number> {
  const parsed = githubComment.safeParse(body);
  if (!parsed.success) return 0;
  const { comment, repository, issue, pull_request } = parsed.data;
  const number = event === "issue_comment" ? issue?.number : pull_request?.number;
  if (!number || comment.user.type === "Bot" || !MENTION.test(comment.body)) return 0;
  const repo = await reviewRepoFor(db, "github", "github.com", String(repository.id));
  if (!repo) return 0;
  return queueReply(
    db,
    service,
    repo.accountId,
    repo.id,
    number,
    String(comment.id),
    event !== "issue_comment",
  );
}

export const gitlabNote = z.object({
  object_kind: z.literal("note"),
  user: z.object({ bot: z.boolean().optional() }).loose().optional(),
  project: z.object({ id: z.number() }),
  object_attributes: z.object({ id, note: z.string(), noteable_type: z.string() }),
  merge_request: z.object({ iid: id }).optional(),
});

/** A GitLab note hook on a merge request, from a repository whose secret matched. */
export async function queueGitlabNote(
  db: Db,
  service: AutoReviewService,
  repo: { id: string; accountId: string },
  note: z.infer<typeof gitlabNote>,
): Promise<number> {
  const { object_attributes: a, merge_request: mr } = note;
  if (a.noteable_type !== "MergeRequest" || !mr || note.user?.bot || !MENTION.test(a.note)) {
    return 0;
  }
  return queueReply(db, service, repo.accountId, repo.id, mr.iid, String(a.id), false);
}

async function queueReply(
  db: Db,
  service: AutoReviewService,
  accountId: string,
  reviewRepoId: string,
  number: number,
  commentId: string,
  inline: boolean,
): Promise<number> {
  const queued = await scoped(db, accountId).replies.queue(reviewRepoId, number, commentId, inline);
  if (queued) service.kick();
  return queued ? 1 : 0;
}
