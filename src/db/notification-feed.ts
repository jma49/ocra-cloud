import { and, count, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { FEED_UNREAD_CAP, type FeedKind } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { notificationFeed } from "./schema.js";

// The account's notification centre (src/notify/feed.ts), newest first and
// paged by (created_at, id). Reached only through scoped().

export type FeedNotice = {
  eventKey: string;
  kind: FeedKind;
  title: string;
  subtitle?: string | null;
  link: string;
  repo?: string | null;
  number?: number | null;
  createdAt?: Date;
};

/** The last listed notice's (created_at, id): the next page starts after it. */
export type FeedCursor = { createdAt: Date; id: string };

export function accountNotificationFeed(db: Db, accountId: string) {
  const t = notificationFeed;
  const own = eq(t.accountId, accountId);
  const unread = and(own, isNull(t.readAt));
  return {
    /** Keeps the notices, each event once: one already kept is left as it is. */
    async record(notices: readonly FeedNotice[]): Promise<void> {
      if (notices.length === 0) return;
      await db
        .insert(t)
        .values(notices.map((n) => ({ ...n, id: crypto.randomUUID(), accountId })))
        .onConflictDoNothing({ target: [t.accountId, t.eventKey] });
    },

    async page(limit: number, before?: FeedCursor) {
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            own,
            before
              ? or(
                  lt(t.createdAt, before.createdAt),
                  and(eq(t.createdAt, before.createdAt), lt(t.id, before.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit);
      const last = rows.at(-1);
      const next =
        rows.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { rows, next };
    },

    /** Unread notices, counted up to FEED_UNREAD_CAP. */
    async unread(): Promise<number> {
      const capped = db.select({ id: t.id }).from(t).where(unread).limit(FEED_UNREAD_CAP).as("u");
      const row = await db.select({ n: count() }).from(capped).then(first);
      return row?.n ?? 0;
    },

    /** Marks the notices read, by id or all created at or before a time; how many were unread. */
    async markRead(which: { ids: readonly string[] } | { before: Date }, now = new Date()) {
      if ("ids" in which && which.ids.length === 0) return 0;
      const res = await db
        .update(t)
        .set({ readAt: now })
        .where(
          and(
            unread,
            "ids" in which ? inArray(t.id, [...which.ids]) : lte(t.createdAt, which.before),
          ),
        );
      return changedRows(res);
    },
  };
}
