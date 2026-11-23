import { inArray, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.js";
import { countWhere } from "./dialect.js";
import {
  generateJobs,
  graphBuilds,
  inboundEvents,
  learnJobs,
  mergeIntents,
  notifyDeliveries,
  replyJobs,
  reviewJobs,
} from "./schema.js";

// What a self-hosted deployment's operators alert on (src/node/metrics.ts):
// counts across every account, never one account's, repository's or
// login's, so each metric has a handful of series whatever the deployment
// holds. A new queue or delivery table is one entry in QUEUES or
// DELIVERIES; anything else, one collector in COLLECTORS.

const HOUR_MS = 60 * 60_000;

/** Every metric the collectors give, with its help line and the only labels it carries. */
export const OPS_METRICS = {
  ocra_jobs: { help: "Jobs queued or running, by queue.", labels: ["queue", "state"] },
  ocra_jobs_failed_last_hour: {
    help: "Jobs that failed for good in the last hour, by queue.",
    labels: ["queue"],
  },
  ocra_jobs_oldest_queued_seconds: {
    help: "How long the oldest queued job has waited, by queue; 0 with none queued.",
    labels: ["queue"],
  },
  ocra_deliveries: {
    help: "Outgoing deliveries kept, by kind and state.",
    labels: ["kind", "state"],
  },
  ocra_delivery_retries_due: {
    help: "Pending deliveries whose next attempt is due now, by kind.",
    labels: ["kind"],
  },
  ocra_inbound_events: {
    help: "Platform webhook deliveries recorded for the steps after their answer, by state.",
    labels: ["state"],
  },
  ocra_merge_intents: { help: "Merge when ready intents not yet ended.", labels: ["state"] },
} as const satisfies Record<string, { help: string; labels: readonly string[] }>;

type OpsMetric = keyof typeof OPS_METRICS;
export type Sample = { metric: OpsMetric; labels: Record<string, string>; value: number };
type Collector = (db: Db, now: Date) => Promise<Sample[]>;

type QueueTable = SQLiteTable & {
  state: SQLiteColumn;
  finishedAt: SQLiteColumn;
  createdAt: SQLiteColumn;
};

/** The job tables a worker or runner takes from, each with queued, running and failed states. */
const QUEUES: Record<string, QueueTable> = {
  review: reviewJobs,
  reply: replyJobs,
  generate: generateJobs,
  learn: learnJobs,
  graph: graphBuilds,
};

type DeliveryTable = SQLiteTable & { state: SQLiteColumn; retryAt: SQLiteColumn };

/** The outgoing delivery tables, each with pending and failed states and a retry time. */
const DELIVERIES: Record<string, DeliveryTable> = { notify: notifyDeliveries };

const is = (column: SQLiteColumn, value: string): SQL => sql`${column} = ${value}`;

async function queue(db: Db, name: string, t: QueueTable, now: Date): Promise<Sample[]> {
  const [row] = await db
    .select({
      queued: countWhere(is(t.state, "queued")).mapWith(Number),
      running: countWhere(is(t.state, "running")).mapWith(Number),
      failed: countWhere(
        sql`${is(t.state, "failed")} AND ${t.finishedAt} >= ${now.getTime() - HOUR_MS}`,
      ).mapWith(Number),
      oldest: sql<number | null>`min(CASE WHEN ${is(t.state, "queued")} THEN ${t.createdAt} END)`,
    })
    .from(t)
    .where(inArray(t.state, ["queued", "running", "failed"]));
  const oldest = row?.oldest == null ? undefined : Number(row.oldest);
  const labels = { queue: name };
  return [
    { metric: "ocra_jobs", labels: { ...labels, state: "queued" }, value: row?.queued ?? 0 },
    { metric: "ocra_jobs", labels: { ...labels, state: "running" }, value: row?.running ?? 0 },
    { metric: "ocra_jobs_failed_last_hour", labels, value: row?.failed ?? 0 },
    {
      metric: "ocra_jobs_oldest_queued_seconds",
      labels,
      value: oldest === undefined ? 0 : Math.max(0, (now.getTime() - oldest) / 1000),
    },
  ];
}

async function deliveries(db: Db, kind: string, t: DeliveryTable, now: Date): Promise<Sample[]> {
  const [row] = await db
    .select({
      pending: countWhere(is(t.state, "pending")).mapWith(Number),
      delivered: countWhere(is(t.state, "delivered")).mapWith(Number),
      failed: countWhere(is(t.state, "failed")).mapWith(Number),
      due: countWhere(sql`${is(t.state, "pending")} AND ${t.retryAt} <= ${now.getTime()}`).mapWith(
        Number,
      ),
    })
    .from(t);
  return [
    { metric: "ocra_deliveries", labels: { kind, state: "pending" }, value: row?.pending ?? 0 },
    {
      metric: "ocra_deliveries",
      labels: { kind, state: "delivered" },
      value: row?.delivered ?? 0,
    },
    { metric: "ocra_deliveries", labels: { kind, state: "failed" }, value: row?.failed ?? 0 },
    { metric: "ocra_delivery_retries_due", labels: { kind }, value: row?.due ?? 0 },
  ];
}

async function inbound(db: Db): Promise<Sample[]> {
  const t = inboundEvents;
  const [row] = await db
    .select({
      pending: countWhere(is(t.state, "pending")).mapWith(Number),
      done: countWhere(is(t.state, "done")).mapWith(Number),
      failed: countWhere(is(t.state, "failed")).mapWith(Number),
    })
    .from(t);
  return (["pending", "done", "failed"] as const).map((state) => ({
    metric: "ocra_inbound_events",
    labels: { state },
    value: row?.[state] ?? 0,
  }));
}

async function intents(db: Db): Promise<Sample[]> {
  const t = mergeIntents;
  const [row] = await db
    .select({
      armed: countWhere(is(t.state, "armed")).mapWith(Number),
      merging: countWhere(is(t.state, "merging")).mapWith(Number),
    })
    .from(t)
    .where(inArray(t.state, ["armed", "merging"]));
  return [
    { metric: "ocra_merge_intents", labels: { state: "armed" }, value: row?.armed ?? 0 },
    { metric: "ocra_merge_intents", labels: { state: "merging" }, value: row?.merging ?? 0 },
  ];
}

const each = <T>(tables: Record<string, T>, read: (name: string, t: T) => Promise<Sample[]>) =>
  Promise.all(Object.entries(tables).map(([name, t]) => read(name, t))).then((s) => s.flat());

/** The collectors, by the name their `ocra_metrics_collector_up` series carries. */
export const COLLECTORS: Record<string, Collector> = {
  jobs: (db, now) => each(QUEUES, (name, t) => queue(db, name, t, now)),
  deliveries: (db, now) => each(DELIVERIES, (kind, t) => deliveries(db, kind, t, now)),
  inbound_events: (db) => inbound(db),
  merge_intents: (db) => intents(db),
};
