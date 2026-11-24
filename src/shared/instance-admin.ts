// GET /api/admin/instance: the deployment's state for the operators that
// INSTANCE_ADMINS names, as counts across every account. It never holds an
// account's, repository's or login's name, id or content (src/admin.ts).

/** The job queues a worker or runner takes from. */
export const INSTANCE_QUEUES = [
  "review",
  "reply",
  "generate",
  "learn",
  "restack",
  "fix",
  "graph",
] as const;
export type InstanceQueue = (typeof INSTANCE_QUEUES)[number];

export type InstanceQueueCounts = {
  queued: number;
  running: number;
  /** Jobs that failed for good in the last 24 hours. */
  failedLast24h: number;
  /** How long the oldest queued job has waited; 0 with none queued. */
  oldestQueuedSeconds: number;
};

export type InstanceStatus = {
  /** ISO 8601: when the counts were read. */
  checkedAt: string;
  /** The engine packages this build pins. */
  engine: { cli: string; contract: string };
  /** The newest migration this build expects, and how the database's compare (null when it records none). */
  schema: {
    newest: string;
    expected: number | null;
    applied: number | null;
    missing: number | null;
    unknown: number | null;
  };
  accounts: number;
  enrolledRepos: number;
  jobs: Record<InstanceQueue, InstanceQueueCounts>;
  /** When a remote runner last asked for work (ISO 8601), null when none did this week; stale past 5 minutes. */
  runners: { lastSeenAt: string | null; stale: boolean };
  /** Outgoing notification deliveries and the platforms' incoming webhooks still to run, due or given up. */
  deliveries: {
    notify: { pending: number; due: number; failed: number };
    inbound: { pending: number; failed: number };
  };
};
