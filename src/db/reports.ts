import { and, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DAY } from "../time.js";
import { keepsStored } from "./accounts.js";
import { type Db, first } from "./client.js";
import { countWhere } from "./dialect.js";
import { findingsIn, type RepoScope, reviewsIn } from "./scheduled-reports.js";
import { accounts, findings, notifyChannels, reviews } from "./schema.js";

// The weekly report's side of the account row (reached through scoped()):
// its slot, the numbers of its week, and the claim on a slot, a
// compare-and-set on the account so that two cron runs or two processes
// send a week's report once.

export type ReportSchedule = { weekday: number; hour: number };

export type ReportNumbers = {
  fixed: number;
  dismissed: number;
  /** Findings of the week still open; null when the account does not share findings. */
  open: number | null;
  /** The repositories the most reviews named, most first. */
  topRepos: { repo: string; reviews: number }[];
};

const TOP_REPOS = 3;
/** Another slot is taken only this long after the last, however the schedule moved. */
const MIN_GAP = 6 * DAY;

export function accountReports(db: Db, accountId: string) {
  const a = accounts;
  return {
    async schedule(): Promise<ReportSchedule> {
      const row = await db
        .select({ weekday: a.reportWeekday, hour: a.reportHour })
        .from(a)
        .where(eq(a.id, accountId))
        .limit(1)
        .then(first);
      return row ?? { weekday: 1, hour: 9 };
    },

    async setSchedule(s: ReportSchedule): Promise<void> {
      await db
        .update(a)
        .set({ reportWeekday: s.weekday, reportHour: s.hour })
        .where(eq(a.id, accountId));
    },

    /**
     * Takes the report of the week ending at slot unless one was taken less
     * than six days before it; the account's sharing setting when it did.
     */
    async claim(slot: Date): Promise<{ shareFindings: boolean } | undefined> {
      const rows = await db
        .update(a)
        .set({ reportSentFor: slot })
        .where(
          and(
            eq(a.id, accountId),
            or(isNull(a.reportSentFor), lte(a.reportSentFor, new Date(slot.getTime() - MIN_GAP))),
          ),
        )
        .returning({ shareFindings: a.shareFindings, hostedFindings: a.hostedFindings });
      const row = first(rows);
      return row && { shareFindings: keepsStored(row) };
    },

    /** What the weekly report adds to the digest's numbers for the reviews between from and to. */
    async numbersOf(
      from: Date,
      to: Date,
      shareFindings: boolean,
      scope?: RepoScope,
    ): Promise<ReportNumbers> {
      const r = reviews;
      const when = and(
        eq(r.accountId, accountId),
        gte(r.createdAt, from),
        lt(r.createdAt, to),
        reviewsIn(scope),
      );
      const f = findings;
      const [outcomes, repos, open] = await Promise.all([
        db
          .select({
            fixed: sql<number>`coalesce(sum(${r.fixed}), 0)`,
            dismissed: sql<number>`coalesce(sum(${r.dismissed}), 0)`,
          })
          .from(r)
          .where(when)
          .limit(1)
          .then(first),
        db
          .select({ repo: sql<string>`${r.prRepository}`, reviews: sql<number>`count(*)` })
          .from(r)
          .where(and(when, isNotNull(r.prRepository)))
          .groupBy(r.prRepository)
          .orderBy(desc(sql`count(*)`), r.prRepository)
          .limit(TOP_REPOS),
        shareFindings
          ? db
              .select({ n: countWhere(sql`${f.status} = 'open'`) })
              .from(f)
              .where(
                and(
                  eq(f.accountId, accountId),
                  gte(f.createdAt, from),
                  lt(f.createdAt, to),
                  findingsIn(db, accountId, scope, from, to),
                ),
              )
              .limit(1)
              .then(first)
          : Promise.resolve(undefined),
      ]);
      return {
        fixed: Number(outcomes?.fixed ?? 0),
        dismissed: Number(outcomes?.dismissed ?? 0),
        open: shareFindings ? Number(open?.n ?? 0) : null,
        topRepos: repos.map((x) => ({ repo: x.repo, reviews: Number(x.reviews) })),
      };
    },
  };
}

/** The accounts with a channel that gets the weekly report, and their slots, read across accounts. */
export async function reportAccounts(db: Db): Promise<({ id: string } & ReportSchedule)[]> {
  const t = notifyChannels;
  return db
    .selectDistinct({ id: accounts.id, weekday: accounts.reportWeekday, hour: accounts.reportHour })
    .from(t)
    .innerJoin(accounts, eq(accounts.id, t.accountId))
    .where(and(eq(t.weekly, true), isNotNull(t.confirmedAt)));
}
