import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { ThreadDismissalState } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { findings, findingThreads, reviews } from "./schema.js";

// The threads ocra's comments of findings started on an enrolled
// repository's pull requests, and what people did to them on the platform
// (src/notify/finding-thread-hooks.ts). A start is kept once per platform
// thread, the first delivered winning. A resolution and a reply each move
// forward only, by the platform's clock, so a redelivery or a late older
// event changes nothing; the starter's own are never a person's. A reply's
// text is kept only when the account keeps the finding on that pull
// request (ADR-0028, 2), and goes when the account deletes its findings.
// Reached only through scoped().

export type FindingThreadStart = {
  reviewRepoId: string;
  /** The repository as a review's prRepository names it. */
  repository: string;
  number: number;
  threadKey: string;
  fingerprint: string;
  starterId: string;
};

type OnThread = { reviewRepoId: string; threadKey: string };

export type FindingThreadState = OnThread & {
  state: ThreadDismissalState;
  /** Who did it: the platform's id, and the login kept; null when the platform does not say. */
  by: { id: string; login: string } | null;
  at: Date;
};

export type FindingThreadReply = OnThread & {
  by: { id: string; login: string };
  at: Date;
  /** Already redacted and cut (redactField). */
  text: string;
  redacted: boolean;
  truncated: boolean;
};

const MAX_LOGIN = 255;
/** Threads of one pull request read at most. */
const MAX_PULL_THREADS = 500;

const t = findingThreads;

export function accountFindingThreads(db: Db, accountId: string) {
  const thread = (on: OnThread) =>
    and(
      eq(t.accountId, accountId),
      eq(t.reviewRepoId, on.reviewRepoId),
      eq(t.threadKey, on.threadKey),
    );
  return {
    /** Keeps the thread's start; one already on record stays as it is. */
    async start(s: FindingThreadStart, now = new Date()): Promise<void> {
      await db
        .insert(t)
        .values({ id: crypto.randomUUID(), accountId, ...s, seenAt: now })
        .onConflictDoNothing({ target: [t.reviewRepoId, t.threadKey] });
    },

    /** The thread on record: who started it, of which finding, and what it says now. */
    async find(on: OnThread) {
      const [row] = await db
        .select({
          starterId: t.starterId,
          state: t.state,
          repository: t.repository,
          number: t.number,
          fingerprint: t.fingerprint,
        })
        .from(t)
        .where(thread(on))
        .limit(1);
      return row ?? null;
    },

    /** Records that a person resolved the thread or opened it again; whether it changed. */
    async setState(s: FindingThreadState, now = new Date()): Promise<boolean> {
      const at = s.at.getTime();
      const result = await db
        .update(t)
        .set({
          state: s.state,
          stateBy: s.by?.login.slice(0, MAX_LOGIN) ?? null,
          stateAt: s.at,
          seenAt: now,
        })
        .where(
          and(
            thread(s),
            sql`${t.starterId} <> ${s.by?.id ?? ""}`,
            sql`(${t.stateAt} IS NULL OR ${t.stateAt} < ${at}
              OR (${t.stateAt} = ${at} AND ${t.state} <> ${s.state}))`,
          ),
        );
      return changedRows(result) > 0;
    },

    /**
     * Keeps a person's reply as the thread's reason when it is newer than
     * the one kept and the account keeps the thread's finding; whether it
     * was kept.
     */
    async reply(r: FindingThreadReply, now = new Date()): Promise<boolean> {
      const at = r.at.getTime();
      const f = findings;
      const kept = sql`EXISTS (SELECT 1 FROM ${f} WHERE ${f.accountId} = ${accountId}
        AND ${f.fingerprint} = ${t.fingerprint}
        AND ${f.reviewId} IN (SELECT ${reviews.id} FROM ${reviews}
          WHERE ${reviews.accountId} = ${accountId} AND ${reviews.prNumber} = ${t.number}
          AND lower(${reviews.prRepository}) = ${t.repository}))`;
      const result = await db
        .update(t)
        .set({
          reason: r.text,
          reasonBy: r.by.login.slice(0, MAX_LOGIN),
          reasonAt: r.at,
          reasonRedacted: r.redacted,
          reasonTruncated: r.truncated,
          seenAt: now,
        })
        .where(
          and(
            thread(r),
            sql`${t.starterId} <> ${r.by.id}`,
            sql`(${t.reasonAt} IS NULL OR ${t.reasonAt} < ${at})`,
            kept,
          ),
        );
      return changedRows(result) > 0;
    },

    /** Drops every reply's text the account keeps: its findings are being deleted. */
    async forgetReasons(): Promise<void> {
      await db
        .update(t)
        .set({
          reason: null,
          reasonBy: null,
          reasonAt: null,
          reasonRedacted: false,
          reasonTruncated: false,
        })
        .where(and(eq(t.accountId, accountId), isNotNull(t.reason)));
    },

    /** The pull request's threads that a person resolved, reopened or replied in. */
    ofPull(repository: string, number: number) {
      return db
        .select()
        .from(t)
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.repository, repository.toLowerCase()),
            eq(t.number, number),
            or(isNotNull(t.state), isNotNull(t.reason)),
          ),
        )
        .limit(MAX_PULL_THREADS);
    },
  };
}
