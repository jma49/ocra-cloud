import { and, asc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { CodePlatformKind as CodePlatform } from "../shared/index.js";
import type { Db } from "./client.js";
import { hasMember, memberIdOk, TEAM_PREFIX } from "./review-teams.js";
import { closedPulls, pullFlows, reviewRepos, reviewRequests, reviewTeams } from "./schema.js";

// The reviews asked of users on an enrolled repository's pull requests, from
// its platform's webhooks (src/auto-review/requests.ts), and what of them,
// and of the user's own pull requests, still waits (src/notify/reminders.ts).
// An ask merges into its row in the statement itself, so a redelivery or a
// late older event changes nothing; nothing here reads the platform. An
// ask of a team (reviewer id "team:<id>") waits for each member the kept
// copy of the team names (./review-teams.ts), and one member's review ends
// it, as it does on the platform.

/** Whose reviews and pull requests: the platform's id of the user there. */
export type PlatformUser = { platform: CodePlatform; host: string; userId: string };

export type Waiting = {
  reviewRepoId: string;
  platform: CodePlatform;
  repo: string;
  number: number;
  title: string | null;
  /** When it started waiting, ms since the epoch. */
  since: number;
  /** The team (org/slug) the review was asked of, with u on it; null when asked of u. */
  team?: string | null;
};

/** An ask, or its end, of reviewerId: the platform's id, and the login where the event names it. */
export type Ask = {
  reviewRepoId: string;
  number: number;
  reviewerId: string;
  reviewer?: string | null;
  at: Date;
};

const MAX_LOGIN = 255;
const r = reviewRequests;
const f = pullFlows;
const c = closedPulls;
const t = reviewTeams;

export function accountReviewRequests(db: Db, accountId: string) {
  const ofRepo = (u: PlatformUser) =>
    and(
      eq(reviewRepos.accountId, accountId),
      eq(reviewRepos.platform, u.platform),
      eq(reviewRepos.host, u.host),
    );
  type Pull = { reviewRepoId: SQLiteColumn; number: SQLiteColumn };
  const flowOf = (p: Pull) =>
    and(eq(f.reviewRepoId, p.reviewRepoId), eq(f.number, p.number), eq(f.accountId, accountId));
  const closeOf = (p: Pull) =>
    and(eq(c.reviewRepoId, p.reviewRepoId), eq(c.number, p.number), eq(c.accountId, accountId));

  return {
    /** Records that a review of the pull request was asked of reviewerId at; the latest ask is kept. */
    async asked(e: Ask) {
      const { at, reviewer, ...ask } = e;
      await db
        .insert(r)
        .values({
          id: crypto.randomUUID(),
          accountId,
          ...ask,
          reviewer: reviewer?.slice(0, MAX_LOGIN) ?? null,
          requestedAt: at,
        })
        .onConflictDoUpdate({
          target: [r.reviewRepoId, r.number, r.reviewerId],
          set: {
            reviewer: sql`coalesce(excluded.reviewer, ${r.reviewer})`,
            requestedAt: sql`CASE WHEN excluded.requested_at > ${r.requestedAt} THEN excluded.requested_at ELSE ${r.requestedAt} END`,
          },
          setWhere: eq(r.accountId, accountId),
        });
    },

    /** Records that reviewerId reviewed the pull request, or was no longer asked, at; the latest is kept. */
    async done(e: Ask) {
      await db
        .update(r)
        .set({
          ...(e.reviewer ? { reviewer: e.reviewer.slice(0, MAX_LOGIN) } : {}),
          doneAt: sql`CASE WHEN ${r.doneAt} IS NULL OR ${r.doneAt} < ${e.at.getTime()} THEN ${e.at.getTime()} ELSE ${r.doneAt} END`,
        })
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.reviewRepoId, e.reviewRepoId),
            eq(r.number, e.number),
            eq(r.reviewerId, e.reviewerId),
          ),
        );
    },

    /** Records that a member of a team asked on the pull request reviewed it at: the teams' asks end. */
    async doneByMember(e: Ask & { platform: CodePlatform; host: string }) {
      if (!memberIdOk(e.reviewerId)) return;
      const teams = db
        .select({ id: t.reviewerId })
        .from(t)
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.platform, e.platform),
            eq(t.host, e.host),
            hasMember(t.members, e.reviewerId),
          ),
        );
      await db
        .update(r)
        .set({
          doneAt: sql`CASE WHEN ${r.doneAt} IS NULL OR ${r.doneAt} < ${e.at.getTime()} THEN ${e.at.getTime()} ELSE ${r.doneAt} END`,
        })
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.reviewRepoId, e.reviewRepoId),
            eq(r.number, e.number),
            inArray(r.reviewerId, teams),
          ),
        );
    },

    /**
     * When u's last round of review on the pull request ended, ms since the
     * epoch: the latest end of an ask of u, or of a team the kept copy names
     * u on; 0 when none has ended. A notice of an ask is claimed under it.
     */
    async roundOf(u: PlatformUser, reviewRepoId: string, number: number): Promise<number> {
      const teams = memberIdOk(u.userId);
      const direct = eq(r.reviewerId, u.userId);
      const [row] = await db
        .select({ at: sql<number>`coalesce(max(${r.doneAt}), 0)`.mapWith(Number) })
        .from(r)
        .leftJoin(
          t,
          teams
            ? and(
                eq(t.accountId, accountId),
                eq(t.platform, u.platform),
                eq(t.host, u.host),
                eq(t.reviewerId, r.reviewerId),
              )
            : sql`1 = 0`,
        )
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.reviewRepoId, reviewRepoId),
            eq(r.number, number),
            teams
              ? or(
                  direct,
                  and(
                    like(r.reviewerId, `${TEAM_PREFIX}%`),
                    isNotNull(t.id),
                    hasMember(t.members, u.userId),
                  ),
                )
              : direct,
          ),
        );
      return row?.at ?? 0;
    },

    /**
     * The open pull requests that asked u's review, or a team's u is on,
     * between from and to and still wait for it, waiting longest first, one
     * per pull request (an ask of u before a team's); drafts are left out.
     */
    async askedOf(u: PlatformUser, from: Date, to: Date, limit: number): Promise<Waiting[]> {
      const teams = memberIdOk(u.userId);
      const ofTeam = and(
        eq(t.accountId, accountId),
        eq(t.platform, u.platform),
        eq(t.host, u.host),
        eq(t.reviewerId, r.reviewerId),
      );
      const direct = eq(r.reviewerId, u.userId);
      const rows = await db
        .select({
          reviewRepoId: r.reviewRepoId,
          platform: reviewRepos.platform,
          repo: reviewRepos.fullName,
          number: r.number,
          title: f.title,
          since: sql<number>`${r.requestedAt}`.mapWith(Number),
          team: sql<string | null>`CASE WHEN ${direct} THEN NULL ELSE ${t.name} END`,
        })
        .from(r)
        .innerJoin(reviewRepos, and(eq(reviewRepos.id, r.reviewRepoId), ofRepo(u)))
        .leftJoin(t, teams ? ofTeam : sql`1 = 0`)
        .leftJoin(f, flowOf(r))
        .leftJoin(c, closeOf(r))
        .where(
          and(
            eq(r.accountId, accountId),
            gte(r.requestedAt, from),
            lte(r.requestedAt, to),
            teams
              ? or(
                  direct,
                  and(
                    like(r.reviewerId, `${TEAM_PREFIX}%`),
                    isNotNull(t.id),
                    hasMember(t.members, u.userId),
                  ),
                )
              : direct,
            or(isNull(r.doneAt), lt(r.doneAt, r.requestedAt)),
            or(isNull(f.id), eq(f.draft, false)),
            // Asked again after a close, or reopened since, it is open.
            or(isNull(c.id), lt(c.closedAt, r.requestedAt), lt(c.closedAt, f.reopenedAt)),
          ),
        )
        .orderBy(asc(r.requestedAt))
        .limit(limit);
      const byPull = new Map<string, Waiting>();
      for (const w of rows) {
        const key = `${w.reviewRepoId}#${w.number}`;
        const kept = byPull.get(key);
        if (!kept || (kept.team && !w.team)) byPull.set(key, w);
      }
      return [...byPull.values()].sort((a, b) => a.since - b.since);
    },

    /**
     * u's own open pull requests, out of draft and without any review, that
     * have waited since between from and to, waiting longest first.
     */
    async unreviewedOf(u: PlatformUser, from: Date, to: Date, limit: number): Promise<Waiting[]> {
      const since = sql`coalesce(${f.reopenedAt}, ${f.readyAt}, ${f.openedAt})`;
      return db
        .select({
          reviewRepoId: f.reviewRepoId,
          platform: reviewRepos.platform,
          repo: reviewRepos.fullName,
          number: f.number,
          title: f.title,
          since: sql<number>`${since}`.mapWith(Number),
        })
        .from(f)
        .innerJoin(reviewRepos, and(eq(reviewRepos.id, f.reviewRepoId), ofRepo(u)))
        .leftJoin(c, closeOf(f))
        .where(
          and(
            eq(f.accountId, accountId),
            // An event is never before it opened: the index finds the rest.
            gte(f.seenAt, from),
            eq(f.authorId, u.userId),
            eq(f.draft, false),
            isNull(f.firstReviewAt),
            or(isNull(c.id), lt(c.closedAt, f.reopenedAt)),
            sql`${since} >= ${from.getTime()}`,
            sql`${since} <= ${to.getTime()}`,
          ),
        )
        .orderBy(asc(since))
        .limit(limit);
    },
  };
}
