import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  type InferInsertModel,
  type InferSelectModel,
  isNull,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  countCall,
  countFindingsOf,
  countOne,
  type DailyKind,
  findingsCounted,
  uncountOne,
} from "./counters.js";
import {
  type Decision,
  decide,
  findingInsights,
  findingStatusCounts,
  type InboxCursor,
  type InboxFilter,
  inbox,
  rememberFindings,
} from "./inbox.js";
import { type PreferencesSave, savePreferences } from "./preferences.js";
import { nameRepo, reviewedRepos } from "./repos.js";
import { accountTables } from "./schema.js";

type Tables = typeof accountTables;
type Name = keyof Tables;
/** The tables whose rows have their own id; preferences is one row per account, keyed by it. */
type IdName = { [N in Name]: "id" extends keyof Tables[N]["$inferSelect"] ? N : never }[Name];
export type Row<N extends Name> = InferSelectModel<Tables[N]>;
type NewRow<N extends Name> = Omit<InferInsertModel<Tables[N]>, "accountId">;
/** A new row; its id is made here unless the caller needs it first. */
type Insert<N extends Name> = N extends IdName
  ? Omit<NewRow<N>, "id"> & { id?: string }
  : NewRow<N>;
type Changes<N extends Name> = Partial<Omit<NewRow<N>, "id">>;
/** Column equality, ANDed with the account; null matches IS NULL. */
export type Where<N extends Name> = { [K in keyof Row<N>]?: Row<N>[K] };

/** A new row's id. */
export const newId = (): string => crypto.randomUUID();

/** What insertReview did with an upload. */
type StoredUpload =
  | { outcome: "stored"; id: string; findingsSkipped: boolean }
  | { outcome: "duplicate"; id: string }
  | { outcome: "limited" };

/**
 * The one way to read and write an account's rows: every query filters by
 * the account, and every insert sets it. Code outside src/db/ does not
 * import the tables.
 */
export function scoped(db: DrizzleD1Database, accountId: string) {
  const own = (name: Name) => eq(accountTables[name].accountId, accountId);
  const byId = (name: IdName, id: string) => and(own(name), eq(accountTables[name].id, id));
  const matching = <N extends Name>(name: N, where: Where<N>) => {
    const t = accountTables[name] as unknown as Record<string, SQLiteColumn>;
    return and(
      own(name),
      ...Object.entries(where).map(([column, value]) => {
        const c = t[column];
        if (!c || column === "accountId") throw new Error(`no column ${column} to match`);
        return value === null ? isNull(c) : eq(c, value);
      }),
    );
  };
  // An id-keyed table's row gets an id unless it brings one.
  const withId = <N extends Name>(name: N, row: Insert<N>) =>
    ("id" in accountTables[name] ? { id: newId(), ...row } : row) as NewRow<N> & { id?: string };
  // Unrun statements for batch(), scoped like the methods below.
  const writes = {
    insert<N extends Name>(name: N, row: Insert<N>): BatchItem<"sqlite"> {
      return db.insert(accountTables[name]).values({ ...withId(name, row), accountId } as never);
    },
    update<N extends IdName>(name: N, id: string, changes: Changes<N>): BatchItem<"sqlite"> {
      const { accountId: _ignored, ...rest } = changes as Record<string, unknown>;
      return db
        .update(accountTables[name])
        .set(rest as never)
        .where(byId(name, id));
    },
    /**
     * Inserts a row, or when this account already has one with the same
     * values in the columns of on (a unique index), sets the rest of the
     * row's fields on that one instead. The stored row keeps its id.
     */
    upsert<N extends Name>(
      name: N,
      row: Insert<N>,
      on: readonly (keyof NewRow<N> | "accountId")[],
    ): BatchItem<"sqlite"> {
      const t = accountTables[name] as unknown as Record<string, SQLiteColumn>;
      const { id: _id, ...set } = row as Record<string, unknown>;
      return db
        .insert(accountTables[name])
        .values({ ...withId(name, row), accountId } as never)
        .onConflictDoUpdate({
          target: on.map((k) => t[k as string] as SQLiteColumn),
          set: set as never,
        });
    },
  };
  return {
    accountId,
    list<N extends Name>(name: N): Promise<Row<N>[]> {
      // The generic table loses drizzle's row type; the row is the table's.
      return db.select().from(accountTables[name]).where(own(name)).all() as Promise<Row<N>[]>;
    },
    /** This account's rows whose columns equal where's values. */
    find<N extends Name>(name: N, where: Where<N>, limit = 10_000): Promise<Row<N>[]> {
      return db
        .select()
        .from(accountTables[name])
        .where(matching(name, where))
        .limit(limit)
        .all() as Promise<Row<N>[]>;
    },
    /** The first such row; for preferences, the account's one row (where is {}). */
    async findOne<N extends Name>(name: N, where: Where<N>): Promise<Row<N> | undefined> {
      return (await db.select().from(accountTables[name]).where(matching(name, where)).get()) as
        | Row<N>
        | undefined;
    },
    /** How many such rows, counted in SQL. */
    async count<N extends Name>(name: N, where: Where<N> = {}): Promise<number> {
      const row = await db
        .select({ n: count() })
        .from(accountTables[name])
        .where(matching(name, where))
        .get();
      return row?.n ?? 0;
    },
    /** This account's newest rows whose columns equal where's values, newest first. */
    listNewest<N extends IdName>(name: N, limit: number, where: Where<N> = {}): Promise<Row<N>[]> {
      const t = accountTables[name];
      return db
        .select()
        .from(t)
        .where(matching(name, where))
        .orderBy(desc(t.createdAt))
        .limit(limit)
        .all() as Promise<Row<N>[]>;
    },
    async get<N extends IdName>(name: N, id: string): Promise<Row<N> | undefined> {
      return (await db.select().from(accountTables[name]).where(byId(name, id)).get()) as
        | Row<N>
        | undefined;
    },
    /** Inserts a row; returns its id (made here unless the row brings one). */
    async insert<N extends Name>(name: N, row: Insert<N>): Promise<string> {
      const full = withId(name, row);
      await db.insert(accountTables[name]).values({ ...full, accountId } as never);
      return full.id ?? accountId;
    },
    /** This account's rows created at or after since, newest first. */
    listSince<N extends Name>(name: N, since: Date, limit = 10_000): Promise<Row<N>[]> {
      const t = accountTables[name];
      return db
        .select()
        .from(t)
        .where(and(own(name), gte(t.createdAt, since)))
        .orderBy(desc(t.createdAt))
        .limit(limit)
        .all() as Promise<Row<N>[]>;
    },
    /** Rows of this account created at or after since. */
    async countSince(name: Name, since: Date): Promise<number> {
      const t = accountTables[name];
      const row = await db
        .select({ n: count() })
        .from(t)
        .where(and(own(name), gte(t.createdAt, since)))
        .get();
      return row?.n ?? 0;
    },
    /** Counts one more of kind today, unless today's count is at cap; returns whether it did. */
    take(kind: DailyKind, cap: number, now = new Date()): Promise<boolean> {
      return countOne(db, accountId, kind, cap, now);
    },
    /** take("gateway_calls") under the account's own budget too (./counters.ts). */
    takeCall(cap: number, now = new Date()): Promise<boolean> {
      return countCall(db, accountId, cap, now);
    },
    /**
     * Remembers a finding for a repository in one statement, so parallel
     * callers cannot all pass a count taken before any of them wrote: only
     * when the repository has no entry with its fingerprint and fewer than
     * cap entries. Returns the entry that has the fingerprint, or "full".
     */
    async remember(
      entry: Omit<NewRow<"accountMemory">, "id">,
      cap: number,
    ): Promise<{ id: string; duplicate: boolean } | "full"> {
      const row = { ...entry, id: newId() };
      const m = accountTables.accountMemory;
      const sameRepo = and(own("accountMemory"), eq(m.repoHash, row.repoHash));
      const same = and(sameRepo, eq(m.fingerprint, row.fingerprint));
      const inserted = await db.insert(m).select(sql`
        SELECT ${row.id}, ${accountId}, ${row.repoHash}, ${row.fingerprint},
          ${row.file ?? null}, ${row.title ?? null}, ${row.reason},
          unixepoch('subsec') * 1000
        WHERE NOT EXISTS (SELECT 1 FROM ${m} WHERE ${same})
          AND (SELECT count(*) FROM ${m} WHERE ${sameRepo}) < ${cap}`);
      if (inserted.meta.changes > 0) return { id: row.id, duplicate: false };
      const existing = await db.select({ id: m.id }).from(m).where(same).get();
      return existing ? { id: existing.id, duplicate: true } : "full";
    },
    /** Saves the preferences unless their version moved; returns whether it did (./preferences.ts). */
    savePreferences(save: PreferencesSave): Promise<boolean> {
      return savePreferences(db, accountId, save);
    },
    /** Runs the statements built from writes in one D1 batch: all of them or none. */
    async batch(build: (w: typeof writes) => BatchItem<"sqlite">[]): Promise<void> {
      const [first, ...rest] = build(writes);
      if (first) await db.batch([first, ...rest]);
    },
    /** Returns whether a row of this account changed. */
    async update<N extends IdName>(name: N, id: string, changes: Changes<N>): Promise<boolean> {
      const { accountId: _ignored, ...rest } = changes as Record<string, unknown>;
      if (Object.keys(rest).length === 0) return false;
      const result = await db
        .update(accountTables[name])
        .set(rest as never)
        .where(byId(name, id))
        .run();
      return result.meta.changes > 0;
    },
    /**
     * Stores a review and its findings atomically, unless this account already
     * has the review's run: then nothing is written and the stored review's id
     * comes back. The findings go in as one statement over a JSON array, so
     * the number of D1 queries does not grow with them.
     *
     * An upload past dailyUploads today writes nothing and comes back
     * `limited`. Findings that would take the account past maxFindings
     * uploaded within the retention window are not stored, and
     * `findingsSkipped` comes back; the review itself is kept. Deleting
     * findings does not give the allowance back: it bounds the rows written,
     * not only the rows kept. Both caps read counter rows (./counters.ts),
     * and the findings' check and count run in the batch that stores them,
     * which D1 runs as one transaction, so concurrent uploads cannot all pass.
     */
    async insertReview(
      counts: Omit<NewRow<"reviews">, "id">,
      list: Omit<NewRow<"findings">, "id" | "reviewId">[],
      limits: { dailyUploads: number; maxFindings: number },
      now = new Date(),
    ): Promise<StoredUpload> {
      const r = accountTables.reviews;
      const storedRun = () =>
        db
          .select({ id: r.id })
          .from(r)
          .where(and(own("reviews"), eq(r.runId, counts.runId)))
          .get();
      // A retry of a stored run is answered as such and counts nothing.
      const before = await storedRun();
      if (before) return { outcome: "duplicate", id: before.id };
      if (!(await countOne(db, accountId, "uploads", limits.dailyUploads, now))) {
        return { outcome: "limited" };
      }
      const review = { ...counts, id: newId() };
      const insert = db
        .insert(r)
        .values({ ...review, accountId })
        .onConflictDoNothing({ target: [r.accountId, r.runId] });
      const rows = JSON.stringify(list.map((f) => ({ ...f, id: newId() })));
      // Only when the review row above was this upload's own, and all of its
      // findings fit in the account's allowance.
      // In the table's column order: insert … select names every column.
      const findings = db.insert(accountTables.findings).select(sql`
        SELECT json_extract(value, '$.id'), ${accountId}, ${review.id},
          json_extract(value, '$.fingerprint'), json_extract(value, '$.reviewer'),
          json_extract(value, '$.severity'), json_extract(value, '$.category'),
          json_extract(value, '$.verification'), json_extract(value, '$.file'),
          json_extract(value, '$.lineStart'), json_extract(value, '$.lineEnd'),
          json_extract(value, '$.title'), json_extract(value, '$.body'),
          json_extract(value, '$.suggestion'), json_extract(value, '$.code'),
          coalesce(json_extract(value, '$.redacted'), 0),
          coalesce(json_extract(value, '$.truncated'), 0),
          unixepoch('subsec') * 1000, 'open', NULL, NULL, NULL
        FROM json_each(${rows})
        WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ${review.id} AND account_id = ${accountId})
          AND ${findingsCounted(accountId, now)} + ${list.length} <= ${limits.maxFindings}`);
      const [stored, kept] =
        list.length > 0
          ? await db.batch([insert, findings, countFindingsOf(db, accountId, review.id, now)])
          : await db.batch([insert]);
      if (stored.meta.changes > 0) {
        const findingsSkipped = list.length > 0 && (kept?.meta.changes ?? 0) === 0;
        return { outcome: "stored", id: review.id, findingsSkipped };
      }
      // A concurrent upload of the same run stored it first: not a second upload.
      await uncountOne(db, accountId, "uploads", now);
      const existing = await storedRun();
      return { outcome: "duplicate", id: existing?.id ?? review.id };
    },
    /**
     * Up to limit rows of this account after the row numbered after, in
     * insertion order, with the number to pass for the next page.
     */
    async page<N extends Name>(
      name: N,
      after: number,
      limit: number,
    ): Promise<{ rows: Row<N>[]; next: number | null }> {
      const t = accountTables[name];
      const seq = sql<number>`${t}.rowid`;
      // The generic table loses drizzle's row type; the row is the table's.
      const rows = (await db
        .select({ ...getTableColumns(t as Tables["sessions"]), seq })
        .from(t)
        .where(and(own(name), gt(seq, after)))
        .orderBy(asc(seq))
        .limit(limit)
        .all()) as unknown as (Row<N> & { seq: number })[];
      const last = rows.at(-1);
      return {
        rows: rows.map(({ seq: _s, ...r }) => r as unknown as Row<N>),
        next: rows.length === limit && last ? last.seq : null,
      };
    },
    /** The account's findings across its reviews (./inbox.ts). */
    inbox(filter: InboxFilter, limit: number, after?: InboxCursor) {
      return inbox(db, accountId, filter, limit, after);
    },
    findingStatusCounts() {
      return findingStatusCounts(db, accountId);
    },
    decide(ids: readonly string[], decision: Decision): Promise<number> {
      return decide(db, accountId, ids, decision);
    },
    findingInsights(since: Date) {
      return findingInsights(db, accountId, since);
    },
    rememberFindings(ids: readonly string[], reason: string, cap: number) {
      return rememberFindings(db, accountId, ids, reason, cap);
    },
    /** The repositories reviewed since a time, summed (./repos.ts). */
    reviewedRepos(since: Date) {
      return reviewedRepos(db, accountId, since);
    },
    nameRepo(repoHash: string, name: string, cap: number): Promise<boolean> {
      return nameRepo(db, accountId, repoHash, name, cap);
    },
    /** The findings of one of this account's reviews. */
    findingsOf(reviewId: string): Promise<Row<"findings">[]> {
      const f = accountTables.findings;
      return db
        .select()
        .from(f)
        .where(and(own("findings"), eq(f.reviewId, reviewId)))
        .all();
    },
    /**
     * Gateway calls since a time, summed in SQL: per UTC day, per provider
     * and model, and per day and model. The groups by model are the busiest
     * first, at most `models` and `dayModels` of them.
     */
    async usage(since: Date, models = 100, dayModels = 2_000) {
      const t = accountTables.gatewayCalls;
      const where = and(own("gatewayCalls"), gte(t.createdAt, since));
      const day = sql<string>`strftime('%Y-%m-%d', ${t.createdAt} / 1000, 'unixepoch')`;
      const model = sql<string>`coalesce(${t.model}, '(unknown)')`;
      const calls = sql<number>`count(*)`;
      const tokensIn = sql<number>`coalesce(sum(${t.tokensIn}), 0)`;
      const tokensOut = sql<number>`coalesce(sum(${t.tokensOut}), 0)`;
      const [days, byModel, byDayModel] = await db.batch([
        db
          .select({
            day,
            calls,
            tokensIn,
            tokensOut,
            errors: sql<number>`coalesce(sum(${t.status} >= 400), 0)`,
          })
          .from(t)
          .where(where)
          .groupBy(day),
        db
          .select({ provider: t.provider, model, calls, tokensIn, tokensOut })
          .from(t)
          .where(where)
          .groupBy(t.provider, model)
          .orderBy(desc(calls))
          .limit(models),
        db
          .select({ day, model, calls, tokens: sql<number>`${tokensIn} + ${tokensOut}` })
          .from(t)
          .where(where)
          .groupBy(day, model)
          .orderBy(desc(calls))
          .limit(dayModels),
      ]);
      return { days, models: byModel, dayModels: byDayModel };
    },
    /** Per provider: the newest gateway call since a time, and the calls since recent. */
    keyUse(since: Date, recent: Date) {
      const t = accountTables.gatewayCalls;
      return db
        .select({
          provider: t.provider,
          lastUsedAt: sql<number>`max(${t.createdAt})`,
          recent: sql<number>`coalesce(sum(${t.createdAt} >= ${recent.getTime()}), 0)`,
        })
        .from(t)
        .where(and(own("gatewayCalls"), gte(t.createdAt, since)))
        .groupBy(t.provider)
        .all();
    },
    /** Reviews since a time, summed in SQL, with the per-reviewer counts summed too. */
    async reviewSummary(since: Date, reviewers = 200) {
      const r = accountTables.reviews;
      const where = and(own("reviews"), gte(r.createdAt, since));
      const total = (c: unknown) => sql<number>`coalesce(sum(${c}), 0)`;
      // Each column has its own name: D1 keys a result row by column name.
      const n = (path: string, as: string) =>
        sql<number>`coalesce(sum(json_extract(je.value, ${path})), 0)`.as(as);
      const [[summary], byReviewer] = await db.batch([
        db
          .select({
            reviews: sql<number>`count(*)`,
            repositories: sql<number>`count(distinct ${r.repoHash})`,
            findings: total(r.findings),
            critical: total(r.critical),
            // significant_concerns is the verdict that blocks a merge.
            blocking: total(sql`${r.verdict} = 'significant_concerns'`),
            incomplete: total(sql`${r.complete} = 0`),
            fixed: total(r.fixed),
            dismissed: total(r.dismissed),
            tokensIn: total(r.tokensIn),
            tokensOut: total(r.tokensOut),
            costUsd: total(r.costUsd),
          })
          .from(r)
          .where(where),
        db
          .select({
            id: sql<string>`je.key`,
            tasks: n("$.tasks", "tasks"),
            failedTasks: n("$.failedTasks", "failedTasks"),
            critical: n("$.findings.critical", "critical"),
            warning: n("$.findings.warning", "warning"),
            suggestion: n("$.findings.suggestion", "suggestion"),
            costUsd: n("$.costUsd", "costUsd"),
            fixed: n("$.fixed", "fixed"),
            dismissed: n("$.dismissed", "dismissed"),
          })
          .from(sql`${r}, json_each(${r.byReviewer}) AS je`)
          .where(and(where, sql`${r.byReviewer} IS NOT NULL`))
          .groupBy(sql`je.key`)
          .orderBy(sql`je.key`)
          .limit(reviewers),
      ]);
      return { summary, byReviewer };
    },
    /** Deletes this account's rows whose columns equal where's values; returns how many. */
    async removeWhere<N extends Name>(name: N, where: Where<N>): Promise<number> {
      const result = await db.delete(accountTables[name]).where(matching(name, where)).run();
      return result.meta.changes;
    },
    /** This account's sessions not yet expired (a CLI session lives as long as its refresh token), newest first. */
    liveSessions(now: Date): Promise<Row<"sessions">[]> {
      const t = accountTables.sessions;
      return db
        .select()
        .from(t)
        .where(
          and(
            own("sessions"),
            gt(sql`coalesce(${t.refreshExpiresAt}, ${t.expiresAt})`, now.getTime()),
          ),
        )
        .orderBy(desc(t.createdAt))
        .all();
    },
    /** Returns whether a row of this account was deleted. */
    async remove(name: IdName, id: string): Promise<boolean> {
      const result = await db.delete(accountTables[name]).where(byId(name, id)).run();
      return result.meta.changes > 0;
    },
  };
}

export type Scoped = ReturnType<typeof scoped>;
