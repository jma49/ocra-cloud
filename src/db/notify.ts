import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { NotifyEvent, NotifyWhen } from "../shared/index.js";
import { DAY } from "../time.js";
import { changedRows, type Db, first } from "./client.js";
import { jsonElements } from "./dialect.js";
import { accounts, findings, notifyChannels, notifyHeld, notifySends, reviews } from "./schema.js";

// The account's channels (reached through scoped()): added in one statement
// under the cap, so parallel adds cannot pass a count taken first; an email
// address confirmed only by the token sent to it, compared in the update
// itself; the daily digest, claimed for a day by a compare-and-set on the
// account, so that two cron runs or two processes send it once; and a pull
// request event, claimed per channel by its key's unique row; one that came
// in the channel's quiet hours held by the same key, then claimed for its
// message by a compare-and-set on claimedAt.

/** How long a notice held in quiet hours waits for them to end; no quiet hours last longer. */
export const HELD_FOR = 2 * DAY;

export type HeldNotice = Omit<typeof notifyHeld.$inferInsert, "id" | "accountId" | "claimedAt">;

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
          ${row.confirmExpiresAt?.getTime() ?? null}, ${row.digest ? 1 : 0}, ${row.weekly ? 1 : 0},
          ${JSON.stringify(row.events ?? [])}, ${row.reminderHours ?? null},
          ${row.quietStart ?? null}, ${row.quietEnd ?? null}
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

    /** The confirmed channels that hear about event. */
    subscribed(event: NotifyEvent) {
      return db
        .select()
        .from(t)
        .where(
          and(
            own,
            isNotNull(t.confirmedAt),
            sql`EXISTS (SELECT 1 FROM ${jsonElements(db, sql`${t.events}`)} WHERE je.value = ${event})`,
          ),
        );
    },

    /** Takes the event for the channel unless it was taken; whether this call did. */
    async claimSend(channelId: string, eventKey: string): Promise<boolean> {
      const res = await db
        .insert(notifySends)
        .values({ id: crypto.randomUUID(), accountId, channelId, eventKey })
        .onConflictDoNothing({ target: [notifySends.channelId, notifySends.eventKey] });
      return changedRows(res) > 0;
    },

    /** Holds the notice for the channel until its quiet hours end, unless it is held; whether this call did. */
    async hold(notice: HeldNotice): Promise<boolean> {
      const res = await db
        .insert(notifyHeld)
        .values({ ...notice, id: crypto.randomUUID(), accountId })
        .onConflictDoNothing({ target: [notifyHeld.channelId, notifyHeld.eventKey] });
      return changedRows(res) > 0;
    },

    /** The confirmed channels with a notice held and not yet claimed. */
    holding() {
      const h = notifyHeld;
      return db
        .select()
        .from(t)
        .where(
          and(
            own,
            isNotNull(t.confirmedAt),
            sql`EXISTS (SELECT 1 FROM ${h} WHERE ${h.accountId} = ${accountId} AND ${h.channelId} = ${t.id} AND ${h.claimedAt} IS NULL)`,
          ),
        );
    },

    /**
     * Takes the channel's newest unclaimed notices held since, at most
     * limit; only those no other run took first, newest first.
     */
    async claimHeld(channelId: string, since: Date, limit: number, now: Date) {
      const h = notifyHeld;
      const unclaimed = and(eq(h.accountId, accountId), isNull(h.claimedAt));
      const newest = db
        .select({ id: h.id })
        .from(h)
        .where(and(unclaimed, eq(h.channelId, channelId), gte(h.createdAt, since)))
        .orderBy(desc(h.createdAt))
        .limit(limit);
      const rows = await db
        .update(h)
        .set({ claimedAt: now })
        .where(and(unclaimed, inArray(h.id, newest)))
        .returning();
      return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    /** Deletes the held notices whose message went. */
    async dropHeld(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await db
        .delete(notifyHeld)
        .where(and(eq(notifyHeld.accountId, accountId), inArray(notifyHeld.id, ids)));
    },

    /** The confirmed channels with reminders. */
    reminding() {
      return db
        .select()
        .from(t)
        .where(and(own, isNotNull(t.reminderHours), isNotNull(t.confirmedAt)));
    },

    async timeZone(): Promise<string> {
      const row = await db
        .select({ timeZone: accounts.timeZone })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
        .then(first);
      return row?.timeZone ?? "UTC";
    },

    async setTimeZone(timeZone: string): Promise<void> {
      await db.update(accounts).set({ timeZone }).where(eq(accounts.id, accountId));
    },

    /** The confirmed channels that get the digest. */
    digesting() {
      return db
        .select()
        .from(t)
        .where(and(own, eq(t.digest, true), isNotNull(t.confirmedAt)));
    },

    /** The confirmed channels that get the weekly report. */
    reporting() {
      return db
        .select()
        .from(t)
        .where(and(own, eq(t.weekly, true), isNotNull(t.confirmedAt)));
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

/** The accounts with a channel that has reminders, read across accounts by the hourly run. */
export async function reminderAccounts(db: Db): Promise<string[]> {
  const t = notifyChannels;
  const rows = await db
    .selectDistinct({ accountId: t.accountId })
    .from(t)
    .where(and(isNotNull(t.reminderHours), isNotNull(t.confirmedAt)));
  return rows.map((r) => r.accountId);
}

/** The accounts with a held notice not yet claimed, read across accounts by the hourly run. */
export async function heldAccounts(db: Db, since: Date, limit: number): Promise<string[]> {
  const h = notifyHeld;
  const rows = await db
    .selectDistinct({ accountId: h.accountId })
    .from(h)
    .where(and(isNull(h.claimedAt), gte(h.createdAt, since)))
    .limit(limit);
  return rows.map((r) => r.accountId);
}
