import { type LiveRun, MAX_LIVE_EVENTS, type ReviewEvent } from "@open-cr-agent/cloud-contract";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { accounts, liveComments, liveEvents, liveGrants, liveRuns } from "./schema.js";

// Reviews relayed while they run (ADR-0056): the owner's side, reached
// through scoped(). Who else may read a run is decided in ./live-access.ts.

// D1 binds at most 100 parameters to a statement; an event row takes six.
const ROWS_PER_INSERT = 16;

const chunks = <T>(list: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, i * size + size),
  );

type LiveRunRow = typeof liveRuns.$inferSelect;
export type LiveEventRow = Pick<typeof liveEvents.$inferSelect, "seq" | "kind" | "data" | "at">;

/** What the run's row learns from a batch of its events. */
function summary(events: readonly ReviewEvent[]) {
  let target: string | undefined;
  let costUsd = 0;
  let ending: { state: "finished" | "failed"; verdict: string | null } | undefined;
  for (const e of events) {
    if (e.kind === "started") target = e.data.target;
    if (e.kind === "usage") costUsd = Math.max(costUsd, e.data.costUsd);
    if (e.kind === "finished") {
      costUsd = Math.max(costUsd, e.data.usage.costUsd);
      ending = { state: "finished", verdict: e.data.verdict };
    }
    if (e.kind === "failed") ending = { state: "failed", verdict: null };
  }
  return { target, costUsd, ending };
}

export function accountLive(db: Db, accountId: string) {
  const own = eq(liveRuns.accountId, accountId);
  return {
    /**
     * Opens the run on its first batch and stores the events it does not
     * have yet (by seq, first write wins), up to MAX_LIVE_EVENTS. The run's
     * id, or undefined once it holds that many and takes no more.
     */
    async record(
      runId: string,
      run: LiveRun,
      events: readonly ReviewEvent[],
      now: Date,
    ): Promise<string | undefined> {
      const [row] = await db
        .insert(liveRuns)
        .values({
          id: crypto.randomUUID(),
          accountId,
          runId,
          repoHash: run.repoHash,
          source: run.source,
          prRepository: run.pullRequest?.repository ?? null,
          prNumber: run.pullRequest?.number ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [liveRuns.accountId, liveRuns.runId],
          set: { updatedAt: now },
        })
        .returning({ id: liveRuns.id, events: liveRuns.events });
      if (!row || row.events >= MAX_LIVE_EVENTS) return undefined;
      const taken = events.slice(0, MAX_LIVE_EVENTS - row.events);
      const rows = taken.map((e) => ({
        accountId,
        liveRunId: row.id,
        seq: e.seq,
        kind: e.kind,
        data: e.data as Record<string, unknown>,
        at: e.at,
      }));
      const inserts = chunks(rows, ROWS_PER_INSERT).map((part) =>
        db
          .insert(liveEvents)
          .values(part)
          .onConflictDoNothing({ target: [liveEvents.liveRunId, liveEvents.seq] }),
      );
      const [head, ...tail] = inserts;
      const results = head ? await db.batch([head, ...tail]) : [];
      const stored = results.reduce((n, r) => n + changedRows(r), 0);
      const { target, costUsd, ending } = summary(taken);
      await db
        .update(liveRuns)
        .set({
          events: sql`${liveRuns.events} + ${stored}`,
          // Usage is cumulative, and a resent batch may arrive after a newer one.
          costUsd: sql`CASE WHEN ${liveRuns.costUsd} < ${costUsd} THEN ${costUsd} ELSE ${liveRuns.costUsd} END`,
          ...(target === undefined ? {} : { target }),
          // An ended run stays ended; a late batch does not reopen it.
          ...(ending
            ? {
                state: sql`CASE WHEN ${liveRuns.state} = 'running' THEN ${ending.state} ELSE ${liveRuns.state} END`,
                verdict: sql`coalesce(${liveRuns.verdict}, ${ending.verdict})`,
              }
            : {}),
        })
        .where(and(own, eq(liveRuns.id, row.id)));
      return row.id;
    },

    /** The account's runs, newest first. */
    runs(limit: number): Promise<LiveRunRow[]> {
      return db.select().from(liveRuns).where(own).orderBy(desc(liveRuns.updatedAt)).limit(limit);
    },

    run(id: string): Promise<LiveRunRow | undefined> {
      return db
        .select()
        .from(liveRuns)
        .where(and(own, eq(liveRuns.id, id)))
        .limit(1)
        .then(first);
    },

    /** The run's events after seq, in order. */
    eventsAfter(liveRunId: string, seq: number, limit: number): Promise<LiveEventRow[]> {
      const e = liveEvents;
      return db
        .select({ seq: e.seq, kind: e.kind, data: e.data, at: e.at })
        .from(e)
        .where(and(eq(e.accountId, accountId), eq(e.liveRunId, liveRunId), gt(e.seq, seq)))
        .orderBy(asc(e.seq))
        .limit(limit);
    },

    /** Turns the run's link on under a new nonce (the old link stops), or off. */
    async setLink(id: string, link: { nonce: string; role: "watch" | "comment" } | null) {
      const result = await db
        .update(liveRuns)
        .set(
          link
            ? { linkNonce: link.nonce, linkRole: link.role }
            : { linkNonce: null, linkRole: null },
        )
        .where(and(own, eq(liveRuns.id, id)));
      return changedRows(result) > 0;
    },

    /** The people the run is shared with, by when they were added. */
    grants(liveRunId: string) {
      const g = liveGrants;
      return db
        .select({ id: g.id, granteeId: g.granteeId, login: accounts.login, role: g.role })
        .from(g)
        .innerJoin(accounts, eq(accounts.id, g.granteeId))
        .where(and(eq(g.accountId, accountId), eq(g.liveRunId, liveRunId)))
        .orderBy(asc(g.createdAt));
    },

    /**
     * Shares the run with a person, or changes their role, in one statement:
     * a new person only while the run has fewer than cap. Whether it did.
     */
    async grant(liveRunId: string, granteeId: string, role: "watch" | "comment", cap: number) {
      const g = liveGrants;
      const result = await db
        .insert(g)
        .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${liveRunId}, ${granteeId}, ${role}, ${Date.now()}
          WHERE EXISTS (SELECT 1 FROM ${liveRuns} WHERE id = ${liveRunId} AND account_id = ${accountId})
            AND ((SELECT count(*) FROM ${g} WHERE live_run_id = ${liveRunId}) < ${cap}
              OR EXISTS (SELECT 1 FROM ${g} WHERE live_run_id = ${liveRunId} AND grantee_id = ${granteeId}))`)
        .onConflictDoUpdate({ target: [g.liveRunId, g.granteeId], set: { role } });
      return changedRows(result) > 0;
    },

    async revoke(liveRunId: string, grantId: string) {
      const g = liveGrants;
      const result = await db
        .delete(g)
        .where(and(eq(g.accountId, accountId), eq(g.liveRunId, liveRunId), eq(g.id, grantId)));
      return changedRows(result) > 0;
    },

    /** The run's comments, oldest first. */
    comments(liveRunId: string, limit: number) {
      const c = liveComments;
      return db
        .select()
        .from(c)
        .where(and(eq(c.accountId, accountId), eq(c.liveRunId, liveRunId)))
        .orderBy(asc(c.createdAt), asc(c.id))
        .limit(limit);
    },

    async comment(
      liveRunId: string,
      author: { id: string; login: string },
      body: string,
      findingId: string | null,
    ) {
      const [row] = await db
        .insert(liveComments)
        .values({
          id: crypto.randomUUID(),
          accountId,
          liveRunId,
          authorId: author.id,
          authorLogin: author.login,
          findingId,
          body,
        })
        .returning();
      if (!row) throw new Error("the comment was not stored");
      return row;
    },

    /** Removes a comment: any, for the owner; else only the author's own. */
    async uncomment(liveRunId: string, commentId: string, by: { id: string; owner: boolean }) {
      const c = liveComments;
      const result = await db
        .delete(c)
        .where(
          and(
            eq(c.accountId, accountId),
            eq(c.liveRunId, liveRunId),
            eq(c.id, commentId),
            by.owner ? undefined : eq(c.authorId, by.id),
          ),
        );
      return changedRows(result) > 0;
    },
  };
}
