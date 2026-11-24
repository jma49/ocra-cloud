import type { CallBudget } from "./calls.js";
import type { ReactionsDue } from "./db/finding-threads.js";
import type { Scoped } from "./db/scoped.js";
import type { CodePlatform } from "./platforms/platform.js";
import { MAX_REACTION_COMMENTS, type Reactions } from "./platforms/reactions.js";
import type { Spent } from "./platforms/reconcile.js";
import { identityOf } from "./review-pull.js";
import { DAY, HOUR, MINUTE } from "./time.js";

// The 👍 and 👎 on ocra's comments of findings, recorded on the findings of
// the comment's pull request (src/db/finding-outcomes.ts). Neither platform
// sends ocra a webhook for a reaction, so they are read, bounded: when a
// person acts on the comment's thread (src/auto-review/finding-threads.ts),
// when the pull request's page loads its threads (as the user, at most once
// in PAGE_READ_EVERY), and in the daily reconciliation, for the threads of
// open pull requests and of those merged within MERGED_DAYS, within its
// budget of calls. A read older than the one kept changes nothing.

/** A pull request's page reads its threads' reactions at most this often. */
const PAGE_READ_EVERY = 10 * MINUTE;
/** The daily reconciliation reads a thread again after this long. */
const RECONCILE_READ_EVERY = 20 * HOUR;
/** Merged pull requests' threads are read this long after the merge. */
const MERGED_DAYS = 14;
/** Threads the reconciliation reads per repository. */
const RECONCILE_THREADS = 40;

type OnRepo = { repository: string; fullName: string };

/** A finding thread's reactions as read at `at`, on its findings and on the thread. */
export async function recordThreadReactions(
  data: Scoped,
  thread: { repository: string; number: number; fingerprint: string; threadKey: string },
  counts: Reactions,
  at: Date,
): Promise<void> {
  await data.findingOutcomes.recordReactions(
    { identity: thread.repository, number: thread.number, fingerprint: thread.fingerprint },
    counts,
    at,
  );
  await data.findingThreads.reactionsRead(thread.repository, [thread.threadKey], at);
}

/** Reads the reactions of the repository's finding threads that are due; how many it recorded. */
async function readFindingReactions(
  data: Scoped,
  platform: Pick<CodePlatform, "reactions">,
  token: string,
  on: OnRepo,
  due: Omit<ReactionsDue, "repository">,
  calls?: CallBudget,
  now = new Date(),
): Promise<number | Spent> {
  const threads = await data.findingThreads.reactionsDue({ ...due, repository: on.repository });
  const byPull = new Map<number, typeof threads>();
  for (const t of threads) byPull.set(t.number, [...(byPull.get(t.number) ?? []), t]);
  let recorded = 0;
  for (const [number, all] of byPull) {
    for (let i = 0; i < all.length; i += MAX_REACTION_COMMENTS) {
      const asked = all.slice(i, i + MAX_REACTION_COMMENTS);
      const read = await platform.reactions.read(
        token,
        on.fullName,
        number,
        asked.map((t) => t.commentId),
        calls,
      );
      if (read === "spent") return "spent";
      if (!read) continue;
      for (const t of asked) {
        const counts = read.get(t.commentId);
        if (counts) {
          await recordThreadReactions(data, { ...t, repository: on.repository }, counts, now);
          recorded++;
        }
      }
      // One the platform no longer has waits as long as one it answered.
      const missing = asked.filter((t) => !read.has(t.commentId)).map((t) => t.threadKey);
      await data.findingThreads.reactionsRead(on.repository, missing, now);
    }
  }
  return recorded;
}

/** The pull request's threads, when its page loads, as the signed-in user. */
export function readPageReactions(
  data: Scoped,
  platform: CodePlatform,
  token: string,
  ref: { repo: string; number: number },
  now = new Date(),
) {
  const identity = identityOf(platform, ref.repo)?.toLowerCase();
  if (!identity) return Promise.resolve(0);
  return readFindingReactions(
    data,
    platform,
    token,
    { repository: identity, fullName: ref.repo },
    {
      numbers: [ref.number],
      readBefore: new Date(now.getTime() - PAGE_READ_EVERY),
      limit: MAX_REACTION_COMMENTS,
    },
    undefined,
    now,
  );
}

/** The daily reconciliation's read of an enrolled repository's threads: of open pull requests, and of those merged lately. */
export function reconcileReactions(r: {
  data: Scoped;
  platform: CodePlatform;
  token: string;
  fullName: string;
  open: readonly number[];
  calls: CallBudget;
  now: Date;
}): Promise<number | Spent> {
  const identity = identityOf(r.platform, r.fullName)?.toLowerCase();
  if (!identity) return Promise.resolve(0);
  return readFindingReactions(
    r.data,
    r.platform,
    r.token,
    { repository: identity, fullName: r.fullName },
    {
      numbers: r.open,
      mergedSince: new Date(r.now.getTime() - MERGED_DAYS * DAY),
      readBefore: new Date(r.now.getTime() - RECONCILE_READ_EVERY),
      limit: RECONCILE_THREADS,
    },
    r.calls,
    r.now,
  );
}
