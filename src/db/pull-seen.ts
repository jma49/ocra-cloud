import { and, eq, isNull, sql } from "drizzle-orm";
import type { CodePlatformKind } from "../shared/index.js";
import { DAY } from "../time.js";
import { changedRows, type Db, first } from "./client.js";
import { jsonRecords, randomId } from "./dialect.js";
import { accounts, pullSeen } from "./schema.js";

// When the account last saw each pull request, for the inbox's unread
// marks. Reached only through scoped().

/** A pull request by platform, repository path (lower case) and number. */
export type SeenPull = { platform: CodePlatformKind; repo: string; number: number };
/** What the account saw of it: the platform's updated_at and head at the time. */
export type SeenMark = SeenPull & { updatedAt: Date; head: string | null };
export type SeenMarker = SeenPull & {
  updatedAt: number;
  head: string | null;
  unread: boolean;
  seenAt: number;
};

const COLUMNS = { platform: "text", repo: "text", number: "bigint" } as const;

export function accountPullSeen(db: Db, accountId: string) {
  const t = pullSeen;
  // SQLite needs the WHERE before an upsert's ON CONFLICT on INSERT ... SELECT.
  const upsert = (list: string, values: { updatedAt: string; head: string; unread: 0 | 1 }) =>
    sql`INSERT INTO ${t} (id, account_id, platform, repo, number, updated_at, head, unread, seen_at)
      SELECT ${randomId(db)}, ${accountId}, je.platform, je.repo, je.number,
        ${sql.raw(values.updatedAt)}, ${sql.raw(values.head)}, ${values.unread}, ${Date.now()}
      FROM ${jsonRecords(db, list, { ...COLUMNS, updated_at: "bigint", head: "text" })}
      WHERE true
      ON CONFLICT (account_id, platform, repo, number) DO UPDATE SET`;
  return {
    /**
     * Before when a pull request with no mark reads as read: when the inbox
     * was first listed (set by the first call, never moved; kept is the
     * session's copy), or the retention cutoff when later, since a mark
     * deleted for age was seen before it, and so was the updated_at it kept.
     */
    async baseline(kept: Date | null, retentionDays: number, now = Date.now()): Promise<number> {
      const a = accounts;
      let since = kept;
      if (since === null) {
        const own = eq(a.id, accountId);
        await db
          .update(a)
          .set({ inboxSince: new Date(now) })
          .where(and(own, isNull(a.inboxSince)));
        since =
          first(await db.select({ at: a.inboxSince }).from(a).where(own))?.at ?? new Date(now);
      }
      return Math.max(since.getTime(), now - retentionDays * DAY);
    },

    /**
     * Marks pull requests read as of what the account saw; a mark older
     * than the one kept changes nothing. How many marks changed.
     */
    async read(marks: readonly SeenMark[]): Promise<number> {
      if (marks.length === 0) return 0;
      const list = JSON.stringify(
        marks.map((m) => ({
          platform: m.platform,
          repo: m.repo,
          number: m.number,
          updated_at: m.updatedAt.getTime(),
          head: m.head,
        })),
      );
      const result =
        await db.run(sql`${upsert(list, { updatedAt: "je.updated_at", head: "je.head", unread: 0 })}
        updated_at = excluded.updated_at, head = excluded.head, unread = 0,
        seen_at = excluded.seen_at
        WHERE excluded.updated_at >= pull_seen.updated_at`);
      return changedRows(result);
    },

    /** Marks pull requests unread until next read; how many marks changed. */
    async unread(pulls: readonly SeenPull[]): Promise<number> {
      if (pulls.length === 0) return 0;
      const list = JSON.stringify(pulls);
      const result = await db.run(sql`${upsert(list, { updatedAt: "0", head: "NULL", unread: 1 })}
        unread = 1, seen_at = excluded.seen_at`);
      return changedRows(result);
    },

    /** The marks kept of these pull requests, by the unique index. */
    async markers(pulls: readonly SeenPull[]): Promise<SeenMarker[]> {
      if (pulls.length === 0) return [];
      const rows = await db
        .select({
          platform: sql<CodePlatformKind>`s.platform`,
          repo: sql<string>`s.repo`,
          number: sql<number>`s.number`,
          updatedAt: sql<number>`s.updated_at`,
          head: sql<string | null>`s.head`,
          unread: sql<number>`s.unread`,
          seenAt: sql<number>`s.seen_at`,
        })
        // CROSS JOIN keeps SQLite from reordering: one lookup per pull by the unique index.
        .from(sql`${jsonRecords(db, JSON.stringify(pulls), COLUMNS)} CROSS JOIN ${t} s`)
        .where(
          sql`s.account_id = ${accountId} AND s.platform = je.platform
            AND s.repo = je.repo AND s.number = je.number`,
        );
      return rows.map((r) => ({
        ...r,
        number: Number(r.number),
        updatedAt: Number(r.updatedAt),
        unread: Number(r.unread) === 1,
        seenAt: Number(r.seenAt),
      }));
    },
  };
}
