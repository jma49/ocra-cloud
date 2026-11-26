import { and, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { DAY, HOUR } from "../time.js";
import type { Db } from "./client.js";
import { rawRows } from "./dialect.js";
import {
  accounts,
  fixJobs,
  generateJobs,
  graphBuilds,
  learnJobs,
  mendJobs,
  pullCommands,
  replyJobs,
  restackJobs,
  reviewJobs,
} from "./schema.js";

// The jobs of auto review a run or a runner left behind: a run that died
// keeps its job running until its lease lapses, and a job nothing claims
// (no runner, a repository whose account never gets a call back) stays
// queued. Each is moved by a compare-and-set on its state, so a run that
// finishes meanwhile, or a claim, wins or loses it whole.

/** A job's runs at most: a run that dies counts as one, so a job that kills its runner ends. */
export const JOB_ATTEMPTS = 3;
/** A job no run took for this long is given up: whatever it answered is long stale. */
const QUEUED_DAYS = 7;

/**
 * An `@ocra` command still pending this long had its run die after the
 * webhook's answer (src/auto-review/commands.ts): it is failed, never run
 * again, so a late retry cannot surprise anyone with a second action.
 */
const COMMAND_PENDING_MS = HOUR;

/** Why a job was given up here, as its `error` says. */
const LEASE_LAPSED = "lease_lapsed";
const NEVER_STARTED = "never_started";

type JobTable =
  | typeof reviewJobs
  | typeof replyJobs
  | typeof generateJobs
  | typeof learnJobs
  | typeof restackJobs
  | typeof fixJobs
  | typeof mendJobs;

/**
 * Queues again the job's runs whose lease lapsed while it has attempts
 * left, and fails the others with LEASE_LAPSED; the claim queries call it
 * before they claim.
 */
export async function recoverLapsed(db: Db, j: JobTable, now: Date): Promise<void> {
  const lapsed = and(eq(j.state, "running"), lt(j.leaseUntil, now));
  await db
    .update(j)
    .set({ state: "failed", leaseUntil: null, error: LEASE_LAPSED, finishedAt: now })
    .where(and(lapsed, gte(j.attempts, JOB_ATTEMPTS)));
  await db
    .update(j)
    .set({ state: "queued", leaseUntil: null })
    .where(and(lapsed, lt(j.attempts, JOB_ATTEMPTS)));
}

/**
 * Every table's lapsed runs, as above, and the jobs queued for more than
 * QUEUED_DAYS failed with NEVER_STARTED, and the commands left pending
 * failed. Runs daily with retention; it calls nothing outside the database.
 */
export async function recoverJobs(db: Db, now = new Date()): Promise<void> {
  const stale = new Date(now.getTime() - QUEUED_DAYS * DAY);
  for (const j of [
    reviewJobs,
    replyJobs,
    generateJobs,
    learnJobs,
    restackJobs,
    fixJobs,
    mendJobs,
  ]) {
    await recoverLapsed(db, j, now);
    await db
      .update(j)
      .set({ state: "failed", error: NEVER_STARTED, finishedAt: now })
      .where(and(eq(j.state, "queued"), lt(j.createdAt, stale)));
  }
  const c = pullCommands;
  await db
    .update(c)
    .set({ outcome: "failed", finishedAt: now })
    .where(
      and(
        // Account by account, through the index that starts with account_id.
        inArray(c.accountId, db.select({ id: accounts.id }).from(accounts)),
        lt(c.createdAt, new Date(now.getTime() - COMMAND_PENDING_MS)),
        eq(c.outcome, "pending"),
      ),
    );
}

/** Every job queue a remote runner may claim from. */
export const CLAIM_KINDS = [
  "review",
  "reply",
  "generate",
  "learn",
  "fix",
  "mend",
  "restack",
  "graph",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

const JOB_TABLES: Record<Exclude<ClaimKind, "graph">, JobTable> = {
  review: reviewJobs,
  reply: replyJobs,
  generate: generateJobs,
  learn: learnJobs,
  fix: fixJobs,
  mend: mendJobs,
  restack: restackJobs,
};

const CLAIM_TABLES: Record<ClaimKind, string> = {
  review: "review_jobs",
  reply: "reply_jobs",
  generate: "generate_jobs",
  learn: "learn_jobs",
  fix: "fix_jobs",
  mend: "mend_jobs",
  restack: "restack_jobs",
  graph: "graph_builds",
};

export type PendingWork = {
  queued: ReadonlySet<ClaimKind>;
  lapsed: ReadonlySet<ClaimKind>;
};

/**
 * Which of `kinds` have a due queued job (and, for kinds where `checkLapsed`
 * applies, a running job whose lease lapsed), in one SQL statement over each
 * table's `(state, created_at)` index so an empty poll skips every per-kind claim.
 */
export async function pendingWork(
  db: Db,
  kinds: readonly ClaimKind[],
  now: Date,
  checkLapsed: boolean | ReadonlySet<ClaimKind>,
): Promise<PendingWork> {
  const queued = new Set<ClaimKind>();
  const lapsed = new Set<ClaimKind>();
  if (kinds.length === 0) return { queued, lapsed };
  const nowMs = now.getTime();
  const wantsLapsed = (kind: ClaimKind) =>
    typeof checkLapsed === "boolean" ? checkLapsed : checkLapsed.has(kind);
  // One scalar SELECT avoids SQLite/D1's compound SELECT term cap.
  const columns: SQL[] = [];
  for (const kind of kinds) {
    const table = sql.raw(CLAIM_TABLES[kind]);
    columns.push(
      sql`EXISTS (SELECT 1 FROM ${table} WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ${nowMs})) AS ${sql.raw(`${kind}_q`)}`,
    );
    if (wantsLapsed(kind)) {
      columns.push(
        sql`EXISTS (SELECT 1 FROM ${table} WHERE state = 'running' AND lease_until < ${nowMs}) AS ${sql.raw(`${kind}_l`)}`,
      );
    }
  }
  const [row] = await rawRows<Record<string, unknown>>(
    db,
    sql`SELECT ${sql.join(columns, sql`, `)}`,
  );
  if (!row) return { queued, lapsed };
  for (const kind of kinds) {
    if (row[`${kind}_q`]) queued.add(kind);
    if (wantsLapsed(kind) && row[`${kind}_l`]) lapsed.add(kind);
  }
  return { queued, lapsed };
}

/** Recovers lapsed leases across every job table, touching only tables that have one. */
export async function recoverLapsedJobs(db: Db, now = new Date()): Promise<void> {
  const { lapsed } = await pendingWork(db, CLAIM_KINDS, now, true);
  for (const kind of lapsed) {
    if (kind === "graph") {
      await db
        .update(graphBuilds)
        .set({ state: "queued", leaseUntil: null })
        .where(and(eq(graphBuilds.state, "running"), lt(graphBuilds.leaseUntil, now)));
    } else {
      await recoverLapsed(db, JOB_TABLES[kind], now);
    }
  }
}
