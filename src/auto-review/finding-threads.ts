import { redactField } from "@open-cr-agent/cloud-contract";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { isBot, user } from "../notify/comment-hooks.js";
import { type StartOf, timeOf } from "../notify/thread-hooks.js";
import { repoIdentity } from "../platforms/platform.js";
import { isBotLogin } from "../platforms/reviewers.js";
import { findingStarting } from "../platforms/threads.js";
import { MAX_DISMISSAL_REASON_CHARS } from "../shared/index.js";

// What people do, on the platform, to the thread of ocra's comment of a
// finding on an enrolled repository's pull request: resolve it, open it
// again, or reply in it (src/db/finding-threads.ts). A comment that starts
// with ocra's marker and starts a thread puts the thread on record with
// its finding's fingerprint; whoever wrote it, and any bot, is not a
// person here. GitHub says a resolution in its pull request review thread
// event, which carries the thread's comments, so it also puts on record a
// thread whose start was missed. GitLab sends nothing when a discussion is
// resolved: its state is read from the discussion when a person writes in
// it (the same read as ../notify/gitlab-starts.ts, made once). A reply's
// text is redacted and cut before it is kept, and never logged. A person's
// answer or resolution also queues the pull request for `ocra learn
// feedback` (src/db/learn-jobs.ts), which reads the threads itself and
// decides whose words count, unless the repository switched that off.

type Repo = Row<"reviewRepos">;
type Person = { id: string; login: string };

type Reply = { by: Person; at: Date; body: string };

/** The repository as a review's prRepository names it; null when its address is not one. */
function identityOf(platformUrl: string, repo: Repo): string | null {
  try {
    return repoIdentity({ url: platformUrl }, repo.fullName).toLowerCase();
  } catch {
    return null;
  }
}

/** How long after a person's last word on a finding's thread its pull request is read: they often answer several. */
const LEARN_AFTER_MS = 5 * 60_000;

async function queueLearning(data: Scoped, repo: Repo, number: number, now: Date) {
  if (repo.learn === "off") return;
  await data.learning.queue(repo.id, number, new Date(now.getTime() + LEARN_AFTER_MS));
}

async function keepReply(data: Scoped, reviewRepoId: string, threadKey: string, reply: Reply) {
  if (reply.body.trim() === "") return;
  const kept = redactField(reply.body.trim(), MAX_DISMISSAL_REASON_CHARS);
  await data.findingThreads.reply({
    reviewRepoId,
    threadKey,
    by: reply.by,
    at: reply.at,
    text: kept.text,
    redacted: kept.redacted,
    truncated: kept.truncated,
  });
}

const githubComment = z.object({
  id: z.number(),
  body: z.string(),
  user,
  created_at: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
});

const githubCommented = z.object({
  action: z.literal("created"),
  pull_request: z.object({ number: z.number().int().min(1) }),
  comment: githubComment,
  repository: z.object({ id: z.number() }),
});

const githubThreadChanged = z.object({
  action: z.enum(["resolved", "unresolved"]),
  pull_request: z.object({ number: z.number().int().min(1), updated_at: z.string().nullish() }),
  thread: z.object({ comments: z.array(githubComment).min(1) }),
  sender: user,
  repository: z.object({ id: z.number() }),
});

const person = (u: z.infer<typeof user>): Person => ({ id: String(u.id), login: u.login });

/** Keeps what a GitHub App delivery says of a finding's thread: its start, a person's reply, its resolution. */
export async function recordGithubFindingThread(
  db: Db,
  host: string,
  platformUrl: string,
  event: string,
  body: unknown,
  now = new Date(),
): Promise<void> {
  const commented =
    event === "pull_request_review_comment" ? githubCommented.safeParse(body).data : undefined;
  const changed =
    event === "pull_request_review_thread" ? githubThreadChanged.safeParse(body).data : undefined;
  const first = commented?.comment ?? changed?.thread.comments[0];
  if (!first) return;
  const starts = first.in_reply_to_id == null;
  const finding = starts ? findingStarting(first.body) : undefined;
  // A reply by a bot, or a comment that starts some other thread, says nothing of a finding.
  if (starts ? !finding : isBot(first.user)) return;
  const repoId = String((commented ?? changed)?.repository.id);
  const repo = await reviewRepoFor(db, "github", host, repoId);
  if (!repo) return;
  const data = scoped(db, repo.accountId);
  const number = (commented ?? changed)?.pull_request.number ?? 0;
  const threadKey = String(first.in_reply_to_id ?? first.id);
  if (finding) {
    const repository = identityOf(platformUrl, repo);
    if (!repository) return;
    await data.findingThreads.start(
      {
        reviewRepoId: repo.id,
        repository,
        number,
        threadKey,
        fingerprint: finding,
        starterId: String(first.user.id),
      },
      now,
    );
  }
  if (commented && !starts) {
    await keepReply(data, repo.id, threadKey, {
      by: person(first.user),
      at: timeOf(first.created_at, now),
      body: first.body,
    });
    const known = await data.findingThreads.find({ reviewRepoId: repo.id, threadKey });
    if (known) await queueLearning(data, repo, number, now);
  }
  if (!changed || isBot(changed.sender)) return;
  await data.findingThreads.setState(
    {
      reviewRepoId: repo.id,
      threadKey,
      state: changed.action,
      by: person(changed.sender),
      at: timeOf(changed.pull_request.updated_at, now),
    },
    now,
  );
  const said = changed.thread.comments
    .slice(1)
    .filter((c) => !isBot(c.user) && c.user.id !== first.user.id);
  const last = said.at(-1);
  if (last) {
    await keepReply(data, repo.id, threadKey, {
      by: person(last.user),
      at: timeOf(last.created_at, now),
      body: last.body,
    });
  }
  if (changed.action === "resolved") await queueLearning(data, repo, number, now);
}

const gitlabNote = z.object({
  user: z.object({ id: z.number(), username: z.string(), bot: z.boolean().optional() }),
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.literal("MergeRequest"),
    system: z.boolean().nullish(),
    discussion_id: z.string().min(1).max(64),
    created_at: z.string().nullish(),
  }),
  merge_request: z.object({ iid: z.number().int().min(1) }),
});

/** Every part of a GitLab note hook that keepGitlabFindingThread reads. */
export const GITLAB_FINDING_THREAD_FIELDS = [gitlabNote];

/** A lookup of a discussion's first note made at most once, and what it answered. */
export function onceEach(startOf: StartOf): StartOf & { asked: StartOf } {
  const answers = new Map<string, ReturnType<StartOf>>();
  const key = (number: number, threadKey: string) => `${number}:${threadKey}`;
  const ask: StartOf = (number, threadKey) => {
    const k = key(number, threadKey);
    const answer = answers.get(k) ?? startOf(number, threadKey);
    answers.set(k, answer);
    return answer;
  };
  /** The answer when it was asked for already; null without a call otherwise. */
  const asked: StartOf = (number, threadKey) =>
    answers.get(key(number, threadKey)) ?? Promise.resolve(null);
  return Object.assign(ask, { asked });
}

/**
 * Keeps what a GitLab note hook says of a finding's discussion: its start,
 * a person's reply, and, read from the discussion, whether it is resolved.
 * `startOf` reads a discussion on record; one that is not on record is
 * taken only from an answer `startOf.asked` already has.
 */
export async function keepGitlabFindingThread(
  db: Db,
  repo: Repo,
  platformUrl: string,
  body: unknown,
  startOf?: ReturnType<typeof onceEach>,
  now = new Date(),
): Promise<void> {
  const parsed = gitlabNote.safeParse(body);
  if (!parsed.success || parsed.data.object_attributes.system) return;
  const { user: u, object_attributes: n, merge_request: mr } = parsed.data;
  const data = scoped(db, repo.accountId);
  const on = { reviewRepoId: repo.id, threadKey: n.discussion_id };
  const start = async (fingerprint: string, starterId: string) => {
    const repository = identityOf(platformUrl, repo);
    if (!repository) return false;
    await data.findingThreads.start(
      { ...on, repository, number: mr.iid, fingerprint, starterId },
      now,
    );
    return true;
  };
  const finding = findingStarting(n.note);
  if (finding) {
    await start(finding, String(u.id));
    return;
  }
  if (u.bot || isBotLogin(u.username)) return;
  let thread = await data.findingThreads.find(on);
  const first = thread
    ? await startOf?.(mr.iid, n.discussion_id)
    : await startOf?.asked(mr.iid, n.discussion_id);
  if (!thread && first?.finding && !first.system && (await start(first.finding, first.authorId))) {
    thread = await data.findingThreads.find(on);
  }
  if (!thread) return;
  const at = timeOf(n.created_at, now);
  await keepReply(data, repo.id, n.discussion_id, {
    by: { id: String(u.id), login: u.username },
    at,
    body: n.note,
  });
  await queueLearning(data, repo, mr.iid, now);
  const resolved = first?.resolved;
  if (!resolved) return;
  if (resolved.resolved) {
    if (resolved.by && isBotLogin(resolved.by.login)) return;
    await data.findingThreads.setState(
      { ...on, state: "resolved", by: resolved.by, at: timeOf(resolved.at, now) },
      now,
    );
  } else if (thread.state === "resolved") {
    // GitLab does not say who opened it again, nor when: no earlier than this note.
    await data.findingThreads.setState({ ...on, state: "unresolved", by: null, at }, now);
  }
}
