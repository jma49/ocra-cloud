import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { HOUR } from "../time.js";
import { keepsStored } from "./accounts.js";
import { changedRows, type Db, first } from "./client.js";
import {
  accounts,
  findings,
  notifyChannels,
  reviewRepos,
  reviews,
  scheduledReportSends,
  scheduledReports,
} from "./schema.js";

// The account's scheduled reports (reached through scoped()): a report is
// added in one statement under the cap, and each period of one is claimed
// by the unique (report, period) index before it is made, so two cron runs
// or two processes send it once.

type NewReport = Omit<
  typeof scheduledReports.$inferInsert,
  "accountId" | "createdAt" | "updatedAt"
>;

/** The repositories a report counts: enrolled ids for merges, and the names reviews carry. */
export type RepoScope = { repoIds: readonly string[]; identities: readonly string[] };

export type ReportPeriod = { reportId: string; period: string; from: Date; to: Date };

export type LastSend = { period: string; at: Date; channels: number };

export function accountScheduledReports(db: Db, accountId: string) {
  const t = scheduledReports;
  const s = scheduledReportSends;
  return {
    /** Adds the report unless the account has cap already; whether it did. */
    async add(row: NewReport & { id: string }, cap: number): Promise<boolean> {
      const now = Date.now();
      const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
      // A boolean is 0 or 1 on every database (./pg/tables.ts); a parameter is not cast.
      const inserted = await db.insert(t).select(sql`
        SELECT ${row.id}, ${accountId}, ${row.name}, ${row.enabled === false ? 0 : 1}, ${row.cadence},
          ${row.hour}, ${row.weekday ?? null}, ${row.monthDay ?? null}, ${json(row.repoIds)},
          ${JSON.stringify(row.sections)}, ${JSON.stringify(row.channelIds)}, ${now}, ${now}
        WHERE (SELECT count(*) FROM ${t} WHERE ${eq(t.accountId, accountId)}) < ${cap}`);
      return changedRows(inserted) > 0;
    },

    /** Takes the report's period unless it was taken; the claim's id, or undefined. */
    async claim(p: ReportPeriod): Promise<string | undefined> {
      const [row] = await db
        .insert(s)
        .values({
          id: crypto.randomUUID(),
          accountId,
          reportId: p.reportId,
          period: p.period,
          periodFrom: p.from,
          periodTo: p.to,
        })
        .onConflictDoNothing({ target: [s.reportId, s.period] })
        .returning({ id: s.id });
      return row?.id;
    },

    /** Records how many channels the claimed period went to. */
    async settle(id: string, channels: number): Promise<void> {
      await db
        .update(s)
        .set({ channels })
        .where(and(eq(s.accountId, accountId), eq(s.id, id)));
    },

    /** Each report's newest period taken, by report id. */
    async lastSends(reportIds: readonly string[]): Promise<Map<string, LastSend>> {
      const rows = await Promise.all(
        reportIds.map((id) =>
          db
            .select({ period: s.period, at: s.createdAt, channels: s.channels })
            .from(s)
            .where(and(eq(s.accountId, accountId), eq(s.reportId, id)))
            .orderBy(desc(s.createdAt))
            .limit(1)
            .then(first),
        ),
      );
      return new Map(reportIds.flatMap((id, i) => (rows[i] ? [[id, rows[i]] as const] : [])));
    },

    /** The account's enrolled repositories of these ids. */
    repos(ids: readonly string[]) {
      if (ids.length === 0) return Promise.resolve([]);
      const r = reviewRepos;
      return db
        .select()
        .from(r)
        .where(and(eq(r.accountId, accountId), inArray(r.id, [...ids])));
    },

    /** Whether the account keeps findings of its own, which a report's titles and open counts need. */
    async keepsFindings(): Promise<boolean> {
      const row = await db
        .select({ shareFindings: accounts.shareFindings, hostedFindings: accounts.hostedFindings })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
        .then(first);
      return row ? keepsStored(row) : false;
    },

    /** The confirmed channels of these ids. */
    channels(ids: readonly string[]) {
      if (ids.length === 0) return Promise.resolve([]);
      const c = notifyChannels;
      return db
        .select()
        .from(c)
        .where(and(eq(c.accountId, accountId), inArray(c.id, [...ids]), isNotNull(c.confirmedAt)));
    },
  };
}

/** The enabled reports of every account, with its time zone, read across accounts by the hourly run. */
export async function enabledReports(db: Db) {
  const t = scheduledReports;
  return db
    .select({
      report: t,
      timeZone: accounts.timeZone,
      shareFindings: accounts.shareFindings,
      hostedFindings: accounts.hostedFindings,
    })
    .from(t)
    .innerJoin(accounts, eq(accounts.id, t.accountId))
    .where(eq(t.enabled, true));
}

/** Reviews of the scope's repositories, by the name each review carries; no condition without a scope. */
export const reviewsIn = (scope: RepoScope | undefined) =>
  scope ? inArray(sql`lower(${reviews.prRepository})`, [...scope.identities]) : undefined;

/** Findings of reviews of the scope's repositories, made between from and to. */
export const findingsIn = (
  db: Db,
  accountId: string,
  scope: RepoScope | undefined,
  from: Date,
  to: Date,
) =>
  scope
    ? inArray(
        findings.reviewId,
        db
          .select({ id: reviews.id })
          .from(reviews)
          .where(
            and(
              eq(reviews.accountId, accountId),
              gte(reviews.createdAt, new Date(from.getTime() - HOUR)),
              lt(reviews.createdAt, to),
              reviewsIn(scope),
            ),
          ),
      )
    : undefined;
