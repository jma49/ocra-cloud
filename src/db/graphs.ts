import { and, desc, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { DAY } from "../time.js";
import { changedRows, type Db, first } from "./client.js";
import { graphBuilds, graphChunks, graphRepos, pullImpacts } from "./schema.js";

// The code graphs the server keeps: an account's graph repositories and
// their builds (accountGraphs, reached through scoped()), and the queries
// that find the account, because a push webhook or the build runner starts
// from a repository or a queued build.

type GraphRepo = typeof graphRepos.$inferSelect;
type NewGraphRepo = Omit<typeof graphRepos.$inferInsert, "id" | "accountId" | "createdAt">;

/** Older builds than this are deleted, except each repository's newest graph. */
export const GRAPH_HISTORY_DAYS = 14;

/** Base64 characters a piece of a graph holds: a multiple of four, well under D1's 2 MB a value. */
const CHUNK_CHARS = 1_200_000;

/** What a build kept: the gzipped graph, in base64, and its counts. */
export type BuiltGraph = {
  content: string;
  files: number;
  parsed: number;
  reused: number;
  skipped: number;
  truncated: boolean;
};

export type BuildSummary = typeof graphBuilds.$inferSelect;

/** A stored graph: the build it is of, and its gzipped bytes. */
export type StoredGraph = {
  commit: string;
  content: Uint8Array<ArrayBuffer>;
  files: number | null;
  truncated: boolean;
};

export function accountGraphs(db: Db, accountId: string) {
  const b = graphBuilds;
  const c = graphChunks;
  const own = eq(b.accountId, accountId);
  const dropChunks = (buildId: string) =>
    db.delete(c).where(and(eq(c.accountId, accountId), eq(c.buildId, buildId)));
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

    /**
     * Queues the commit's build again when it finished, failed or was passed
     * by a newer push; returns whether it did. A build still queued or
     * running is left alone, and a finished one's graph is dropped.
     */
    async rebuild(graphRepoId: string, commit: string, now: Date): Promise<boolean> {
      const result = await db
        .insert(b)
        .values({ id: crypto.randomUUID(), accountId, graphRepoId, commit, createdAt: now })
        .onConflictDoUpdate({
          target: [b.graphRepoId, b.commit],
          set: {
            state: "queued",
            attempts: 0,
            notBefore: null,
            leaseUntil: null,
            error: null,
            bytes: null,
            files: null,
            parsed: null,
            reused: null,
            skipped: null,
            truncated: false,
            finishedAt: null,
            createdAt: now,
          },
          setWhere: sql`${own} AND ${notInArray(b.state, ["queued", "running"])}`,
        })
        .returning({ id: b.id });
      const [queued] = result;
      if (queued) await dropChunks(queued.id);
      return queued !== undefined;
    },

    /** Each repository's newest build, without its graph. */
    latestBuilds(): Promise<BuildSummary[]> {
      const newest = sql`${b.createdAt} = (SELECT max(n.created_at) FROM ${b} n WHERE n.graph_repo_id = ${b.graphRepoId})`;
      return db.select().from(b).where(and(own, newest));
    },

    /** The repository's graph of the commit, or its newest graph when commit is undefined. */
    async newestGraph(graphRepoId: string, commit?: string): Promise<StoredGraph | undefined> {
      const build = await db
        .select({ id: b.id, commit: b.commit, files: b.files, truncated: b.truncated })
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
      if (!build) return undefined;
      const pieces = await db
        .select({ data: c.data })
        .from(c)
        .where(and(eq(c.accountId, accountId), eq(c.buildId, build.id)))
        .orderBy(c.seq);
      if (pieces.length === 0) return undefined;
      const content = new Uint8Array(Buffer.from(pieces.map((p) => p.data).join(""), "base64"));
      return { commit: build.commit, content, files: build.files, truncated: build.truncated };
    },

    /**
     * Keeps a running build's graph, only while it is still the run that
     * claimed it (attempts unchanged): a run whose lease lapsed and was
     * claimed again writes nothing. Without `history` the repository's
     * older graphs go. Returns whether it was kept.
     */
    async finishBuild(
      id: string,
      attempts: number,
      built: BuiltGraph,
      now: Date,
      history = true,
    ): Promise<boolean> {
      const claimed = sql`EXISTS (SELECT 1 FROM ${b} WHERE ${b.id} = ${id} AND ${own}
        AND ${b.state} = 'running' AND ${b.attempts} = ${attempts})`;
      await dropChunks(id);
      for (let seq = 0; seq * CHUNK_CHARS < built.content.length; seq++) {
        const data = built.content.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS);
        await db
          .insert(c)
          .select(
            sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${id}, ${seq}, ${data}, ${now.getTime()}
              WHERE ${claimed}`,
          )
          .onConflictDoNothing();
      }
      const [done] = await db
        .update(b)
        .set({
          state: "done",
          bytes: Buffer.byteLength(built.content, "base64"),
          files: built.files,
          parsed: built.parsed,
          reused: built.reused,
          skipped: built.skipped,
          truncated: built.truncated,
          error: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(and(own, eq(b.id, id), eq(b.state, "running"), eq(b.attempts, attempts)))
        .returning({ graphRepoId: b.graphRepoId });
      if (done && !history) {
        const older = db
          .select({ id: b.id })
          .from(b)
          .where(and(own, eq(b.graphRepoId, done.graphRepoId), ne(b.id, id)));
        await db.delete(c).where(and(eq(c.accountId, accountId), inArray(c.buildId, older)));
      }
      return done !== undefined;
    },

    /** Keeps what the pull request reached at its newest review, in place of the last one kept. */
    async keepImpact(graphRepoId: string, number: number, head: string, view: string, now: Date) {
      const t = pullImpacts;
      await db
        .insert(t)
        .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${graphRepoId}, ${number}, ${head},
          ${view}, ${now.getTime()}
          WHERE EXISTS (SELECT 1 FROM ${graphRepos} WHERE ${graphRepos.id} = ${graphRepoId}
            AND ${graphRepos.accountId} = ${accountId})`)
        .onConflictDoUpdate({
          target: [t.graphRepoId, t.number],
          set: { head: sql`excluded.head`, view: sql`excluded.view`, createdAt: now },
        });
    },

    /** The JSON kept of what the pull request reached; undefined when none was. */
    keptImpact(graphRepoId: string, number: number): Promise<string | undefined> {
      const t = pullImpacts;
      return db
        .select({ view: t.view })
        .from(t)
        .where(
          and(eq(t.accountId, accountId), eq(t.graphRepoId, graphRepoId), eq(t.number, number)),
        )
        .limit(1)
        .then((rows) => rows[0]?.view);
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
  recover = true,
): Promise<ClaimedBuild | undefined> {
  const b = graphBuilds;
  const due = and(eq(b.state, "queued"), or(isNull(b.notBefore), lte(b.notBefore, now)));
  const busy = sql`EXISTS (SELECT 1 FROM ${b} r WHERE r.graph_repo_id = ${b.graphRepoId}
    AND r.state = 'running' AND r.lease_until > ${now.getTime()})`;
  const lapsed = and(eq(b.state, "running"), lt(b.leaseUntil, now));
  // A run that died keeps its row running until its lease lapses: queued again here.
  if (recover) await db.update(b).set({ state: "queued", leaseUntil: null }).where(lapsed);
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
