import { and, desc, eq, lte } from "drizzle-orm";
import type { CommentCommand, CommentCommandOutcome } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { pausedPulls, pullCommands } from "./schema.js";

// @ocra commands (reached through scoped()): each comment runs once, by the
// unique index on its id, and a pull request is paused once, by the unique
// index on its number.

export function accountPullCommands(db: Db, accountId: string) {
  const c = pullCommands;
  const p = pausedPulls;
  const own = eq(c.accountId, accountId);
  const ownPause = eq(p.accountId, accountId);
  return {
    /** Records the comment's command unless it was recorded before; its row's id when it is new. */
    async record(
      reviewRepoId: string,
      number: number,
      commentId: string,
      command: CommentCommand,
    ): Promise<string | undefined> {
      const id = crypto.randomUUID();
      const result = await db
        .insert(c)
        .values({ id, accountId, reviewRepoId, number, commentId, command })
        .onConflictDoNothing({ target: [c.reviewRepoId, c.commentId] });
      return changedRows(result) > 0 ? id : undefined;
    },
    /** Records how the command ended, once. */
    async settle(id: string, outcome: Exclude<CommentCommandOutcome, "pending">, now: Date) {
      await db
        .update(c)
        .set({ outcome, finishedAt: now })
        .where(and(own, eq(c.id, id), eq(c.outcome, "pending")));
    },
    /** Stops the pull request's automatic reviews; whether it was running them. */
    async pause(reviewRepoId: string, number: number): Promise<boolean> {
      const result = await db
        .insert(p)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number })
        .onConflictDoNothing({ target: [p.reviewRepoId, p.number] });
      return changedRows(result) > 0;
    },
    /** Runs the pull request's automatic reviews again; whether they were paused. */
    async resume(reviewRepoId: string, number: number): Promise<boolean> {
      const result = await db
        .delete(p)
        .where(and(ownPause, eq(p.reviewRepoId, reviewRepoId), eq(p.number, number)));
      return changedRows(result) > 0;
    },
    /** Drops the pause of a pull request that closed at closedAt; one made after it, on a reopened pull request, stays. */
    async closed(reviewRepoId: string, number: number, closedAt: Date): Promise<void> {
      await db
        .delete(p)
        .where(
          and(
            ownPause,
            eq(p.reviewRepoId, reviewRepoId),
            eq(p.number, number),
            lte(p.createdAt, closedAt),
          ),
        );
    },
    /** The pull request's newest commands, found through the repository's index. */
    newest(reviewRepoId: string, number: number, limit: number) {
      return db
        .select({
          command: c.command,
          outcome: c.outcome,
          createdAt: c.createdAt,
          finishedAt: c.finishedAt,
        })
        .from(c)
        .where(and(own, eq(c.reviewRepoId, reviewRepoId), eq(c.number, number)))
        .orderBy(desc(c.createdAt))
        .limit(limit);
    },
    async paused(reviewRepoId: string, number: number): Promise<boolean> {
      const row = await db
        .select({ id: p.id })
        .from(p)
        .where(and(ownPause, eq(p.reviewRepoId, reviewRepoId), eq(p.number, number)))
        .limit(1)
        .then(first);
      return row !== undefined;
    },
  };
}
