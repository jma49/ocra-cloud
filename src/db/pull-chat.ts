import { and, desc, eq, sql } from "drizzle-orm";
import type { CodePlatformKind, ReviewChatRole } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { pullChatMessages } from "./schema.js";

// A pull request's "Ask ocra" conversation (reached through scoped()). The
// cap on its messages is checked in the statement that adds one, so
// parallel questions cannot all pass a count taken before any of them wrote.

export type PullChatRow = typeof pullChatMessages.$inferSelect;
/** A pull request by platform, repository path (lower case) and number. */
export type ChatPull = { platform: CodePlatformKind; repo: string; number: number };
/** What a question was asked about besides the whole pull request. */
export type ChatFocus = { findingId: string | null; file: string | null };

export function accountPullChat(db: Db, accountId: string) {
  const m = pullChatMessages;
  const ofPull = (p: ChatPull) =>
    and(
      eq(m.accountId, accountId),
      eq(m.platform, p.platform),
      eq(m.repo, p.repo),
      eq(m.number, p.number),
    );
  return {
    /** Adds a message while the pull request has fewer than cap; the new row's id, or null when full. */
    async add(
      pull: ChatPull,
      role: ReviewChatRole,
      text: string,
      focus: ChatFocus,
      at: Date,
      cap: number,
    ): Promise<string | null> {
      const id = crypto.randomUUID();
      const inserted = await db.insert(m).select(sql`
        SELECT ${id}, ${accountId}, ${pull.platform}, ${pull.repo}, ${pull.number}, ${role},
          ${text}, ${focus.findingId}, ${focus.file}, ${at.getTime()}
        WHERE (SELECT count(*) FROM ${m} WHERE ${ofPull(pull)}) < ${cap}`);
      return changedRows(inserted) > 0 ? id : null;
    },
    /** The newest `limit` messages, oldest first. */
    async latest(pull: ChatPull, limit: number): Promise<PullChatRow[]> {
      const rows = await db
        .select()
        .from(m)
        .where(ofPull(pull))
        .orderBy(desc(m.createdAt))
        .limit(limit);
      return rows.reverse();
    },
  };
}
