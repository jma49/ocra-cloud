// cloudflare:test in the Postgres project: an execution context whose
// waitUntil promises a test can wait on, and migrations already applied
// (./db.ts).

type Context = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };
const pending = new WeakMap<Context, Promise<unknown>[]>();

export function createExecutionContext(): Context {
  const list: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void list.push(p),
    passThroughOnException() {},
  };
  pending.set(ctx, list);
  return ctx;
}

export async function waitOnExecutionContext(ctx: Context): Promise<void> {
  await Promise.allSettled(pending.get(ctx) ?? []);
}

export function createScheduledController(options: { scheduledTime?: number; cron?: string } = {}) {
  return {
    scheduledTime: options.scheduledTime ?? Date.now(),
    cron: options.cron ?? "",
    noRetry() {},
  };
}

export async function applyD1Migrations(): Promise<void> {}
