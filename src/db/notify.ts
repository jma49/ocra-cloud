import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { NotifyWhen } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { accounts, findings, notifyChannels, reviews } from "./schema.js";

// The account's channels (reached through scoped()): added in one statement
// under the cap, so parallel adds cannot pass a count taken first; an email
// address confirmed only by the token sent to it, compared in the update
// itself; and the daily digest, claimed for a day by a compare-and-set on
// the account, so that two cron runs or two processes send it once.

type NewChannel = Omit<
  typeof notifyChannels.$inferInsert,
  "accountId" | "createdAt" | "lastStatus" | "lastSentAt"
>;

const DIGEST_TITLES = 5;

export type DigestNumbers = {
  reviews: number;
  pulls: number;
  critical: number;
  warning: number;
  suggestion: number;
  /** Still open, critical before warning; empty when the account does not share findings. */
  open: { title: string; file: string; severity: string }[];
};

export function accountNotify(db: Db, accountId: string) {
  const t = notifyChannels;
  const own = eq(t.accountId, accountId);
  return {
    /** Adds the channel unless the account has cap already; whether it did. */
    async add(row: NewChannel & { id: string }, cap: number): Promise<boolean> {
      const inserted = await db.insert(t).select(sql`
        SELECT ${row.id}, ${accountId}, ${row.kind}, ${row.name}, ${row.when},
          ${row.wrappedKey}, ${row.ciphertext}, ${row.last4}, NULL, NULL, ${Date.now()},
          ${row.confirmedAt?.getTime() ?? null}, ${row.confirmTokenHash ?? null},
          ${row.confirmExpiresAt?.getTime() ?? null}, ${row.digest ? 1 : 0}
        WHERE (SELECT count(*) FROM ${t} WHERE ${own}) < ${cap}`);
      return changedRows(inserted) > 0;
    },

    /** The confirmed channels set to one of whens. */
    listening(whens: readonly NotifyWhen[]) {
      return db
        .select()
        .from(t)
        .where(and(own, inArray(t.when, [...whens]), isNotNull(t.confirmedAt)));
    },

    /** The confirmed channels that get the digest. */
    digesting() {
      return db
        .select()
        .from(t)
        .where(and(own, eq(t.digest, true), isNotNull(t.confirmedAt)));
    },

    /** A new link for an unconfirmed address; false once it is confirmed or gone. */
    async rearm(id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
      const res = await db
        .update(t)
        .set({ confirmTokenHash: tokenHash, confirmExpiresAt: expiresAt })
        .where(and(own, eq(t.id, id), isNull(t.confirmedAt)));
      return changedRows(res) > 0;
    },

    /** Confirms the address whose unexpired token hashes to tokenHash; whether one was. */
    async confirm(id: string, tokenHash: string, now: Date): Promise<boolean> {
      const res = await db
        .update(t)
        .set({ confirmedAt: now, confirmTokenHash: null, confirmExpiresAt: null })
        .where(
          and(
            own,
            eq(t.id, id),
            isNull(t.confirmedAt),
            eq(t.confirmTokenHash, tokenHash),
            gt(t.confirmExpiresAt, now),
          ),
        );
      return changedRows(res) > 0;
    },

    /**
     * Takes the digest of day for this account unless it, or a later one,
     * was taken; the account's sharing setting when it did.
     */
    async claimDigest(day: string): Promise<{ shareFindings: boolean } | undefined> {
      const a = accounts;
      const rows = await db
        .update(a)
        .set({ digestDay: day })
        .where(and(eq(a.id, accountId), or(isNull(a.digestDay), lt(a.digestDay, day))))
        .returning({ shareFindings: a.shareFindings });
      return first(rows);
    },

    /** What the account's reviews between from and to found, and what of it is still open. */
    async digestOf(from: Date, to: Date, shareFindings: boolean): Promise<DigestNumbers> {
      const r = reviews;
      const when = and(eq(r.accountId, accountId), gte(r.createdAt, from), lt(r.createdAt, to));
      const [counts, open] = await Promise.all([
        db
          .select({
            reviews: sql<number>`count(*)`,
            pulls: sql<number>`count(DISTINCT ${r.prRepository} || '#' || ${r.prNumber})`,
            critical: sql<number>`coalesce(sum(${r.critical}), 0)`,
            warning: sql<number>`coalesce(sum(${r.warning}), 0)`,
            suggestion: sql<number>`coalesce(sum(${r.suggestion}), 0)`,
          })
          .from(r)
          .where(when)
          .limit(1)
          .then(first),
        shareFindings
          ? db
              .select({ title: findings.title, file: findings.file, severity: findings.severity })
              .from(findings)
              .where(
                and(
                  eq(findings.accountId, accountId),
                  eq(findings.status, "open"),
                  gte(findings.createdAt, from),
                  lt(findings.createdAt, to),
                  inArray(findings.severity, ["critical", "warning"]),
                ),
              )
              .orderBy(
                sql`CASE WHEN ${findings.severity} = 'critical' THEN 0 ELSE 1 END`,
                desc(findings.createdAt),
              )
              .limit(DIGEST_TITLES)
          : Promise.resolve([]),
      ]);
      return {
        reviews: Number(counts?.reviews ?? 0),
        pulls: Number(counts?.pulls ?? 0),
        critical: Number(counts?.critical ?? 0),
        warning: Number(counts?.warning ?? 0),
        suggestion: Number(counts?.suggestion ?? 0),
        open,
      };
    },
  };
}

/** The accounts with a channel that gets the digest, read across accounts by the daily run. */
export async function digestAccounts(db: Db): Promise<string[]> {
  const t = notifyChannels;
  const rows = await db
    .selectDistinct({ accountId: t.accountId })
    .from(t)
    .where(and(eq(t.digest, true), isNotNull(t.confirmedAt)));
  return rows.map((r) => r.accountId);
}
