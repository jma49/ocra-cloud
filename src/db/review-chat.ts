import { and, desc, eq, sql } from "drizzle-orm";
import type { ReviewChatRole } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { reviewChatMessages, reviews } from "./schema.js";

// A review's "Ask ocra" conversation (reached through scoped()). The cap on
// its messages is checked in the statement that adds one, so parallel
// questions cannot all pass a count taken before any of them wrote.

export type ChatMessageRow = typeof reviewChatMessages.$inferSelect;

export function accountReviewChat(db: Db, accountId: string) {
  const m = reviewChatMessages;
  const ofReview = (reviewId: string) => and(eq(m.accountId, accountId), eq(m.reviewId, reviewId));
  return {
    /**
     * Adds a message to the account's own review while it has fewer than cap;
     * the new row's id, or null when the review is not the account's or full.
     */
    async add(
      reviewId: string,
      role: ReviewChatRole,
      text: string,
      at: Date,
      cap: number,
    ): Promise<string | null> {
      const id = crypto.randomUUID();
      const r = reviews;
      const inserted = await db.insert(m).select(sql`
        SELECT ${id}, ${accountId}, ${reviewId}, ${role}, ${text}, ${at.getTime()}
        WHERE EXISTS (SELECT 1 FROM ${r} WHERE ${and(eq(r.accountId, accountId), eq(r.id, reviewId))})
          AND (SELECT count(*) FROM ${m} WHERE ${ofReview(reviewId)}) < ${cap}`);
      return changedRows(inserted) > 0 ? id : null;
    },
    /** The newest `limit` messages, oldest first. */
    async latest(reviewId: string, limit: number): Promise<ChatMessageRow[]> {
      const rows = await db
        .select()
        .from(m)
        .where(ofReview(reviewId))
        .orderBy(desc(m.createdAt))
        .limit(limit);
      return rows.reverse();
    },
  };
}
