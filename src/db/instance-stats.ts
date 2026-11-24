import { count } from "drizzle-orm";
import { INSTANCE_QUEUES, type InstanceQueue, type InstanceQueueCounts } from "../shared/index.js";
import { DAY } from "../time.js";
import type { Db } from "./client.js";
import { checkMigrations, type MigrationCheck } from "./migrations.js";
import {
  DELIVERIES,
  deliveryCounts,
  inboundCounts,
  QUEUES,
  queueCounts,
  waitedSeconds,
} from "./ops-metrics.js";
import { newestRunnerSeen } from "./review-runners.js";
import { accounts, reviewRepos } from "./schema.js";

// The deployment's state for its operators (src/admin.ts): counts across
// every account, as /metrics reads them (./ops-metrics.ts), never a row of
// one. Outside scoped() on purpose: no account's data is read, only how
// many rows there are.

export type InstanceStats = {
  accounts: number;
  enrolledRepos: number;
  jobs: Record<InstanceQueue, InstanceQueueCounts>;
  runnerSeenAt: Date | undefined;
  notify: { pending: number; due: number; failed: number };
  inbound: { pending: number; failed: number };
  migrations: MigrationCheck | undefined;
};

const rows = (db: Db, table: typeof accounts | typeof reviewRepos) =>
  db
    .select({ n: count() })
    .from(table)
    .then(([row]) => Number(row?.n ?? 0));

export async function instanceStats(db: Db, now: Date): Promise<InstanceStats> {
  const failedSince = now.getTime() - DAY;
  const [accountCount, repoCount, queues, runnerSeenAt, notify, inbound, migrations] =
    await Promise.all([
      rows(db, accounts),
      rows(db, reviewRepos),
      Promise.all(INSTANCE_QUEUES.map((q) => queueCounts(db, QUEUES[q], failedSince))),
      newestRunnerSeen(db, now),
      deliveryCounts(db, DELIVERIES.notify, now),
      inboundCounts(db),
      checkMigrations(db),
    ]);
  const jobs = Object.fromEntries(
    INSTANCE_QUEUES.map((q, i) => {
      const c = queues[i] ?? { queued: 0, running: 0, failed: 0, oldestQueuedAt: undefined };
      const counts: InstanceQueueCounts = {
        queued: c.queued,
        running: c.running,
        failedLast24h: c.failed,
        oldestQueuedSeconds: Math.round(waitedSeconds(c.oldestQueuedAt, now)),
      };
      return [q, counts];
    }),
  ) as Record<InstanceQueue, InstanceQueueCounts>;
  return {
    accounts: accountCount,
    enrolledRepos: repoCount,
    jobs,
    runnerSeenAt,
    notify: { pending: notify.pending, due: notify.due, failed: notify.failed },
    inbound: { pending: inbound.pending, failed: inbound.failed },
    migrations,
  };
}
