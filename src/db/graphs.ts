import { and, desc, eq, getTableColumns, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { DAY } from "../time.js";
import { changedRows, type Db, first } from "./client.js";
import { graphBuilds, graphRepos } from "./schema.js";

// The code graphs the server keeps: an account's graph repositories and
// their builds (accountGraphs, reached through scoped()), and the queries
// that find the account, because a push webhook or the build runner starts
// from a repository or a queued build.

type GraphRepo = typeof graphRepos.$inferSelect;
type NewGraphRepo = Omit<typeof graphRepos.$inferInsert, "id" | "accountId" | "createdAt">;

/** Older builds than this are deleted, except each repository's newest graph. */
export const GRAPH_HISTORY_DAYS = 14;

/** What a build kept: the gzipped graph and its counts. */
export type BuiltGraph = {
  content: Uint8Array;
  files: number;
  parsed: number;
  reused: number;
  skipped: number;
  truncated: boolean;
};

export type BuildSummary = Omit<typeof graphBuilds.$inferSelect, "content">;

const { content: _content, ...buildSummary } = getTableColumns(graphBuilds);

export function accountGraphs(db: Db, accountId: string) {
  const b = graphBuilds;
  const own = eq(b.accountId, accountId);
  return {
    /**
     * Adds a repository, or brings an added one's name and branch up to
     * date, in one statement: a new one only while the account has fewer
     * than cap. Returns its id, or undefined at the cap.
     */
    async addRepo(repo: NewGraphRepo, cap: number): Promise<string | undefined> {
      const t = graphRepos;
      const [row] = await db
        .insert(t)
        .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${repo.platform}, ${repo.host},
          ${repo.platformRepoId}, ${repo.fullName}, ${repo.branch}, ${repo.webhookSecretHash ?? null},
          ${repo.consentedAt?.getTime() ?? null}, ${Date.now()}
        WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
          OR EXISTS (SELECT 1 FROM ${t} WHERE account_id = ${accountId} AND platform = ${repo.platform}
            AND host = ${repo.host} AND platform_repo_id = ${repo.platformRepoId})`)
        .onConflictDoUpdate({
          target: [t.accountId, t.platform, t.host, t.platformRepoId],
          set: {
            fullName: sql`excluded.full_name`,
            branch: sql`excluded.branch`,
            webhookSecretHash: sql`excluded.webhook_secret_hash`,
            consentedAt: sql`coalesce(${t.consentedAt}, excluded.consented_at)`,
          },
        })
        .returning({ id: t.id });
      return row?.id;
    },

    /** Queues a build of the commit unless the repository has one; returns whether it did. */
    async queueBuild(graphRepoId: string, commit: string): Promise<boolean> {
      const result = await db
        .insert(b)
        .values({ id: crypto.randomUUID(), accountId, graphRepoId, commit })
        .onConflictDoNothing({ target: [b.graphRepoId, b.commit] });
      return changedRows(result) > 0;
    },

    /** Each repository's newest build, without its graph. */
    latestBuilds(): Promise<BuildSummary[]> {
      const newest = sql`${b.createdAt} = (SELECT max(n.created_at) FROM ${b} n WHERE n.graph_repo_id = ${b.graphRepoId})`;
      return db.select(buildSummary).from(b).where(and(own, newest));
    },

    /** The repository's graph of the commit, or its newest graph when commit is undefined. */
    newestGraph(graphRepoId: string, commit?: string) {
      return db
        .select({ commit: b.commit, content: b.content, finishedAt: b.finishedAt })
        .from(b)
        .where(
          and(
            own,
            eq(b.graphRepoId, graphRepoId),
            eq(b.state, "done"),
            commit === undefined ? undefined : eq(b.commit, commit),
          ),
        )
        .orderBy(desc(b.finishedAt))
        .limit(1)
        .then(first);
    },

    /**
     * Keeps a running build's graph, only while it is still the run that
     * claimed it (attempts unchanged): a run whose lease lapsed and was
     * claimed again writes nothing. Returns whether it was kept.
     */
    async finishBuild(id: string, attempts: number, built: BuiltGraph, now: Date) {
      const result = await db
        .update(b)
        .set({
          state: "done",
          content: Buffer.from(built.content),
          bytes: built.content.byteLength,
          files: built.files,
          parsed: built.parsed,
          reused: built.reused,
          skipped: built.skipped,
          truncated: built.truncated,
          error: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(and(own, eq(b.id, id), eq(b.state, "running"), eq(b.attempts, attempts)));
      return changedRows(result) > 0;
    },

    /** Queues the build again at retryAt, or gives it up with the error when retryAt is null. */
    async releaseBuild(
      id: string,
      attempts: number,
      error: string,
      retryAt: Date | null,
      now: Date,
    ) {
      await db
        .update(b)
        .set(
          retryAt
            ? { state: "queued", notBefore: retryAt, leaseUntil: null, error }
            : { state: "failed", leaseUntil: null, error, finishedAt: now },
        )
        .where(and(own, eq(b.id, id), eq(b.state, "running"), eq(b.attempts, attempts)));
    },

    /** Deletes the repository's graphs and finished builds; one running finishes into nothing. */
    async purgeBuilds(graphRepoId: string): Promise<number> {
      const result = await db
        .delete(b)
        .where(and(own, eq(b.graphRepoId, graphRepoId), ne(b.state, "running")));
      return changedRows(result);
    },
  };
}

/** The graph repositories of every account on this platform repository. */
export function reposForPush(
  db: Db,
  platform: GraphRepo["platform"],
  host: string,
  platformRepoId: string,
): Promise<GraphRepo[]> {
  const t = graphRepos;
  return db
    .select()
    .from(t)
    .where(and(eq(t.platform, platform), eq(t.host, host), eq(t.platformRepoId, platformRepoId)))
    .limit(1_000);
}

/** A build this runner now owns, until leaseUntil. */
export type ClaimedBuild = {
  id: string;
  accountId: string;
  graphRepoId: string;
  commit: string;
  attempts: number;
  leaseUntil: Date;
};

/**
 * Claims the next build: of the oldest repository waiting, its newest queued
 * commit (the older ones are superseded), unless that repository already has
 * a build running under a live lease, so one repository builds one commit at
 * a time. The claim is a compare-and-set on the queued state, so two runners
 * never own one build.
 */
export async function claimBuild(
  db: Db,
  now: Date,
  leaseMs: number,
): Promise<ClaimedBuild | undefined> {
  const b = graphBuilds;
  const due = and(eq(b.state, "queued"), or(isNull(b.notBefore), lte(b.notBefore, now)));
  const busy = sql`EXISTS (SELECT 1 FROM ${b} r WHERE r.graph_repo_id = ${b.graphRepoId}
    AND r.state = 'running' AND r.lease_until > ${now.getTime()})`;
  const lapsed = and(eq(b.state, "running"), lt(b.leaseUntil, now));
  // A run that died keeps its row running until its lease lapses: queued again here.
  await db.update(b).set({ state: "queued", leaseUntil: null }).where(lapsed);
  const waiting = await db
    .select({ graphRepoId: b.graphRepoId })
    .from(b)
    .where(and(due, sql`NOT ${busy}`))
    .orderBy(b.createdAt)
    .limit(1)
    .then(first);
  if (!waiting) return undefined;
  const queued = await db
    .select({ id: b.id })
    .from(b)
    .where(and(due, eq(b.graphRepoId, waiting.graphRepoId)))
    .orderBy(desc(b.createdAt));
  const [newest, ...older] = queued;
  if (!newest) return undefined;
  if (older.length > 0) {
    await db
      .update(b)
      .set({ state: "superseded", finishedAt: now })
      .where(
        and(
          eq(b.state, "queued"),
          inArray(
            b.id,
            older.map((o) => o.id),
          ),
        ),
      );
  }
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const [claimed] = await db
    .update(b)
    .set({ state: "running", leaseUntil, attempts: sql`${b.attempts} + 1` })
    .where(and(eq(b.id, newest.id), eq(b.state, "queued")))
    .returning({
      id: b.id,
      accountId: b.accountId,
      graphRepoId: b.graphRepoId,
      commit: b.commit,
      attempts: b.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

/**
 * Deletes builds older than GRAPH_HISTORY_DAYS but each repository's newest
 * graph; with keep false, every build that is not running.
 */
export async function pruneGraphBuilds(db: Db, keep: boolean, now = new Date()): Promise<number> {
  const b = graphBuilds;
  const idle = ne(b.state, "running");
  if (!keep) return changedRows(await db.delete(b).where(idle));
  const cutoff = new Date(now.getTime() - GRAPH_HISTORY_DAYS * DAY);
  const newestGraph = sql`${b.id} = (SELECT n.id FROM ${b} n WHERE n.graph_repo_id = ${b.graphRepoId}
    AND n.state = 'done' ORDER BY n.finished_at DESC LIMIT 1)`;
  const result = await db
    .delete(b)
    .where(and(idle, lt(b.createdAt, cutoff), sql`NOT ${newestGraph}`));
  return changedRows(result);
}
