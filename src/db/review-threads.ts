import { and, eq, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { CodePlatformKind } from "../shared/index.js";
import type { Db } from "./client.js";
import { jsonRecords } from "./dialect.js";
import { reviewThreads } from "./schema.js";

// The review threads started on an enrolled repository's pull requests
// (src/notify/threads.ts). A start is kept once per platform thread, the
// first delivered winning; a reply moves the thread's newest reply, the
// starter's or someone else's, forward only, so a redelivery or a late
// older reply changes nothing. Reached only through scoped().

export type ThreadStart = {
  reviewRepoId: string;
  number: number;
  threadKey: string;
  starterId: string;
  starterLogin: string;
  startedAt: Date;
};

export type ThreadReply = {
  reviewRepoId: string;
  threadKey: string;
  /** The platform's id of who replied. */
  byId: string;
  at: Date;
};

/** A thread a reply was written in: who started it, and on which pull request. */
export type RepliedThread = { number: number; starterId: string };

/** A thread the user started whose newest reply by someone else is newer than their own. */
export type WaitingThread = { repo: string; number: number; repliedAt: number };

const MAX_LOGIN = 255;
/** Threads one inbox listing reads. */
const MAX_WAITING = 2000;

const t = reviewThreads;
const forward = (column: SQLiteColumn, at: Date, when: SQL) =>
  sql`CASE WHEN ${when} AND (${column} IS NULL OR ${column} < ${at.getTime()}) THEN ${at.getTime()} ELSE ${column} END`;

export function accountReviewThreads(db: Db, accountId: string) {
  return {
    /** Keeps the thread's start; one already on record stays as it is. */
    async start(s: ThreadStart, now = new Date()): Promise<void> {
      await db
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          accountId,
          reviewRepoId: s.reviewRepoId,
          number: s.number,
          threadKey: s.threadKey,
          starterId: s.starterId,
          starterLogin: s.starterLogin.slice(0, MAX_LOGIN),
          startedAt: s.startedAt,
          seenAt: now,
        })
        .onConflictDoNothing({ target: [t.reviewRepoId, t.threadKey] });
    },

    /** Records a reply in a thread on record; the thread, or null when its start is not. */
    async reply(r: ThreadReply, now = new Date()): Promise<RepliedThread | null> {
      const own = sql`${t.starterId} = ${r.byId}`;
      const other = sql`${t.starterId} <> ${r.byId}`;
      const [row] = await db
        .update(t)
        .set({
          repliedAt: forward(t.repliedAt, r.at, other),
          starterRepliedAt: forward(t.starterRepliedAt, r.at, own),
          seenAt: now,
        })
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.reviewRepoId, r.reviewRepoId),
            eq(t.threadKey, r.threadKey),
          ),
        )
        .returning({ number: t.number, starterId: t.starterId });
      return row ? { number: Number(row.number), starterId: row.starterId } : null;
    },

    /**
     * The threads starterId started on these pull requests (repository
     * path lower case) of the platform's enrolled repositories, each whose
     * newest reply by someone else came after the starter's own.
     */
    async waiting(
      platform: { kind: CodePlatformKind; host: string },
      starterId: string,
      pulls: readonly { repo: string; number: number }[],
    ): Promise<WaitingThread[]> {
      if (pulls.length === 0) return [];
      const list = JSON.stringify(pulls.map((p) => ({ repo: p.repo, number: p.number })));
      const rows = await db
        .select({
          repo: sql<string>`je.repo`,
          number: sql<number>`je.number`,
          repliedAt: sql<number>`th.replied_at`,
        })
        // CROSS JOIN keeps SQLite from reordering: the account's repositories, then each pull's threads by index.
        .from(
          sql`${jsonRecords(db, list, { repo: "text", number: "bigint" })}
            CROSS JOIN review_repos rr CROSS JOIN ${t} th`,
        )
        .where(
          sql`rr.account_id = ${accountId} AND rr.platform = ${platform.kind}
            AND rr.host = ${platform.host} AND lower(rr.full_name) = je.repo
            AND th.review_repo_id = rr.id AND th.number = je.number
            AND th.starter_id = ${starterId} AND th.account_id = ${accountId}
            AND th.replied_at IS NOT NULL
            AND (th.starter_replied_at IS NULL OR th.replied_at > th.starter_replied_at)`,
        )
        .limit(MAX_WAITING);
      return rows.map((r) => ({
        repo: r.repo,
        number: Number(r.number),
        repliedAt: Number(r.repliedAt),
      }));
    },
  };
}
