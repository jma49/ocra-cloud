import { type AnyColumn, and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { REPO_PAUSED_ERROR, type RepoPause } from "../shared/index.js";
import type { Db } from "./client.js";
import {
  accountMemory,
  findingThreads,
  fixJobs,
  generateJobs,
  graphRepos,
  learnJobs,
  liveRuns,
  mergeIntents,
  pullFileViews,
  pullSeen,
  replyJobs,
  repositories,
  restackJobs,
  reviewJobs,
  reviewRepos,
  reviews,
  stackMergeLayers,
  stackMerges,
} from "./schema.js";

// A repository's life on its platform (src/auto-review/lifecycle.ts): a
// rename or transfer moves every row that names it by path or by the hash
// of its address to the new name, and a removal pauses its jobs. Rows are
// found by the platform's own id where they keep it; the rest by the old
// name, compare-and-set. A row whose new key is taken already is left as
// it is, so a move never breaks a unique key.

type Platform = (typeof reviewRepos.$inferSelect)["platform"];

/** The repository a webhook or the reconciliation names, by the platform's id. */
export type PlatformRepoRef = { platform: Platform; host: string; platformRepoId: string };

export type RepoRename = PlatformRepoRef & {
  from: string;
  to: string;
  /** The account's hashes of the old and new address (src/platforms/platform.ts repoHashOf). */
  hashes: { from: string; to: string } | null;
};

/** A claim's condition: the job's repository is not paused. */
export const repoRuns = (reviewRepoId: AnyColumn): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${reviewRepos} p WHERE p.id = ${reviewRepoId} AND p.paused IS NOT NULL)`;

/** The accounts that enrolled or keep a graph of the repository, with their enrollment's name. */
export async function accountsOfRepo(
  db: Db,
  ref: PlatformRepoRef,
): Promise<{ accountId: string; fullName: string }[]> {
  const byId = (t: typeof reviewRepos | typeof graphRepos) =>
    and(
      eq(t.platform, ref.platform),
      eq(t.host, ref.host),
      eq(t.platformRepoId, ref.platformRepoId),
    );
  const [enrolled, graphs] = await db.batch([
    db
      .select({ accountId: reviewRepos.accountId, fullName: reviewRepos.fullName })
      .from(reviewRepos)
      .where(byId(reviewRepos)),
    db
      .select({ accountId: graphRepos.accountId, fullName: graphRepos.fullName })
      .from(graphRepos)
      .where(byId(graphRepos)),
  ]);
  const seen = new Map<string, string>();
  for (const r of [...enrolled, ...graphs])
    if (!seen.has(r.accountId)) seen.set(r.accountId, r.fullName);
  return [...seen].map(([accountId, fullName]) => ({ accountId, fullName }));
}

/**
 * The enrolled GitHub repositories on the host, of any account, that the
 * platform ids name or whose owner is `owner` (a GitHub login: letters,
 * digits and hyphens, so no LIKE wildcard), at most `cap`.
 */
export function githubReposOf(
  db: Db,
  host: string,
  match: { ids: readonly string[]; owner: string | null },
  cap: number,
): Promise<{ id: string; accountId: string; fullName: string; paused: RepoPause | null }[]> {
  const t = reviewRepos;
  const owner =
    match.owner && /^[A-Za-z0-9-]+$/.test(match.owner)
      ? sql`lower(${t.fullName}) LIKE ${`${match.owner.toLowerCase()}/%`}`
      : undefined;
  const ids = match.ids.length > 0 ? inArray(t.platformRepoId, [...match.ids]) : undefined;
  if (!owner && !ids) return Promise.resolve([]);
  return db
    .select({ id: t.id, accountId: t.accountId, fullName: t.fullName, paused: t.paused })
    .from(t)
    .where(and(eq(t.platform, "github"), eq(t.host, host), or(ids, owner)))
    .limit(cap);
}

/** What pausing gives up: the queued jobs of every kind. */
const JOBS = [reviewJobs, replyJobs, generateJobs, learnJobs, restackJobs, fixJobs] as const;

/** The pauses each one replaces: none replaces a deleted repository's. */
const OUTRANKS: Record<RepoPause, readonly RepoPause[]> = {
  deleted: ["removed", "suspended", "uninstalled"],
  removed: ["suspended"],
  uninstalled: ["removed", "suspended"],
  suspended: [],
};

export function accountRepoLifecycle(db: Db, accountId: string) {
  const own = <T extends { accountId: AnyColumn }>(t: T) => eq(t.accountId, accountId);

  /**
   * Sets the account's rows whose `col` is `from` (where `scope` holds) to
   * `set`, whose first value is `col`'s new one, unless a row with the same
   * `keys` already has that.
   */
  const move = (
    t: SQLiteTable,
    col: string,
    keys: readonly string[],
    scope: SQL,
    from: string,
    set: Record<string, string>,
  ) => {
    const to = Object.values(set)[0];
    const same = keys.map((k) => sql` AND o.${sql.identifier(k)} = ${t}.${sql.identifier(k)}`);
    return db
      .update(t)
      .set(set)
      .where(
        sql`${t}.account_id = ${accountId} AND ${scope} AND ${t}.${sql.identifier(col)} = ${from}
          AND NOT EXISTS (SELECT 1 FROM ${t} o WHERE o.account_id = ${accountId}
            AND o.${sql.identifier(col)} = ${to}${sql.join(same, sql``)})`,
      );
  };

  return {
    /**
     * Renames the repository in every row of the account that names it;
     * whether its enrollment was renamed (false when it was already, or it
     * is not enrolled), all in one transaction.
     */
    async rename(r: RepoRename): Promise<boolean> {
      const lower = { from: r.from.toLowerCase(), to: r.to.toLowerCase() };
      const onHost = sql`platform = ${r.platform} AND host = ${r.host}`;
      const onPlatform = sql`platform = ${r.platform}`;
      const byId = <T extends typeof reviewRepos | typeof graphRepos>(t: T) =>
        and(
          own(t),
          eq(t.platform, r.platform),
          eq(t.host, r.host),
          eq(t.platformRepoId, r.platformRepoId),
        );
      const enrolled = db.select({ id: reviewRepos.id }).from(reviewRepos).where(byId(reviewRepos));
      const hashed = r.hashes && r.hashes.from !== r.hashes.to ? r.hashes : null;
      const [renamed] = await db.batch([
        db
          .update(reviewRepos)
          .set({ fullName: r.to })
          .where(and(byId(reviewRepos), ne(reviewRepos.fullName, r.to)))
          .returning({ id: reviewRepos.id }),
        db
          .update(graphRepos)
          .set({ fullName: r.to })
          .where(and(byId(graphRepos), ne(graphRepos.fullName, r.to))),
        db
          .update(findingThreads)
          .set({ repository: lower.to })
          .where(
            and(
              own(findingThreads),
              inArray(findingThreads.reviewRepoId, enrolled),
              eq(findingThreads.repository, lower.from),
            ),
          ),
        move(mergeIntents, "full_name", ["platform", "host", "number"], onHost, lower.from, {
          fullName: lower.to,
        }),
        move(stackMerges, "full_name", ["platform", "host", "bottom"], onHost, lower.from, {
          fullName: lower.to,
          path: r.to,
        }),
        move(stackMergeLayers, "full_name", ["platform", "host", "number"], onHost, lower.from, {
          fullName: lower.to,
        }),
        move(pullSeen, "repo", ["platform", "number"], onPlatform, lower.from, { repo: lower.to }),
        move(pullFileViews, "repo", ["platform", "number", "path"], onPlatform, lower.from, {
          repo: lower.to,
        }),
        ...(hashed
          ? [
              ...[reviews, liveRuns].map((t) =>
                db
                  .update(t)
                  .set({
                    repoHash: hashed.to,
                    prRepository: sql`CASE WHEN lower(${t.prRepository}) = ${lower.from} THEN ${r.to} ELSE ${t.prRepository} END`,
                  })
                  .where(and(own(t), eq(t.repoHash, hashed.from))),
              ),
              db
                .update(accountMemory)
                .set({ repoHash: hashed.to })
                .where(and(own(accountMemory), eq(accountMemory.repoHash, hashed.from))),
              move(repositories, "repo_hash", [], sql`true`, hashed.from, {
                repoHash: hashed.to,
                name: r.to,
              }),
            ]
          : []),
      ]);
      return renamed.length > 0;
    },

    /**
     * Pauses the account's repositories, unless a pause that outranks this
     * one holds, and gives up their queued jobs; the ids it paused.
     */
    async pause(ids: readonly string[], reason: RepoPause, now: Date): Promise<string[]> {
      if (ids.length === 0) return [];
      const t = reviewRepos;
      const may = or(isNull(t.paused), inArray(t.paused, [...OUTRANKS[reason]]));
      const paused = await db
        .update(t)
        .set({ paused: reason })
        .where(and(own(t), inArray(t.id, [...ids]), may))
        .returning({ id: t.id });
      const changed = paused.map((p) => p.id);
      if (changed.length === 0) return [];
      const [head, ...tail] = JOBS.map((j) =>
        db
          .update(j)
          .set({ state: "failed", error: REPO_PAUSED_ERROR, finishedAt: now })
          .where(and(own(j), inArray(j.reviewRepoId, changed), eq(j.state, "queued"))),
      );
      if (head) await db.batch([head, ...tail]);
      return changed;
    },

    /** Lifts the pause of the account's repositories paused for `reason`; the ids it resumed. */
    async resume(ids: readonly string[], reason: RepoPause): Promise<string[]> {
      if (ids.length === 0) return [];
      const t = reviewRepos;
      const resumed = await db
        .update(t)
        .set({ paused: null })
        .where(and(own(t), inArray(t.id, [...ids]), eq(t.paused, reason)))
        .returning({ id: t.id });
      return resumed.map((r) => r.id);
    },
  };
}
