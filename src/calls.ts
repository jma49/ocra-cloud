import { AsyncLocalStorage } from "node:async_hooks";

// The external calls a scheduled run may make. The Workers Free plan allows
// 50 subrequests per invocation, so the hourly cron's jobs share one budget
// (src/cron-calls.ts). Every call the server makes goes through
// outboundFetch, which counts it against the budget of the job it runs in
// and refuses it, without calling, once that budget is spent; outside a
// budget (a request, the Node server's timers) it is plain fetch.

/** The calls a job may still make; `fetch` counts each and refuses past the limit. */
export class CallBudget {
  private used = 0;
  /** Calls refused here or in a budget taken from it. */
  refused = 0;
  /** Whether the job wanted more than it had: a call refused, or a check that found too few left. */
  short = false;

  constructor(
    readonly limit: number,
    private readonly parent?: CallBudget,
  ) {}

  get left(): number {
    const own = this.limit - this.used;
    return this.parent ? Math.min(own, this.parent.left) : own;
  }

  get spent(): number {
    return this.used;
  }

  /** Whether `n` calls are left; a job checks before it claims work that needs them. */
  has(n = 1): boolean {
    if (this.left >= n) return true;
    this.markShort();
    return false;
  }

  /** A budget that draws on this one, at most `limit` of it. */
  child(limit = Number.POSITIVE_INFINITY): CallBudget {
    return new CallBudget(limit, this);
  }

  /** Counts one call; false, counting none, when none is left. */
  take(): boolean {
    if (this.left < 1) {
      this.refuse();
      return false;
    }
    this.count();
    return true;
  }

  private count(): void {
    this.used++;
    this.parent?.count();
  }

  private refuse(): void {
    this.refused++;
    this.parent?.refuse();
    this.markShort();
  }

  private markShort(): void {
    this.short = true;
    this.parent?.markShort();
  }
}

/** A budget with no limit: where a host has none, the job still has one to check. */
export const uncapped = () => new CallBudget(Number.POSITIVE_INFINITY);

/** The call the budget refused; nothing was sent. */
class CallsSpent extends Error {
  override name = "CallsSpent";
}

const scopes = new AsyncLocalStorage<CallBudget>();

/** Runs `fn` with its external calls counted against `calls`. */
export const withCalls = <T>(calls: CallBudget, fn: () => Promise<T>): Promise<T> =>
  scopes.run(calls, fn);

/** How an item went: its value, or cut when one of its calls was refused (thrown or not). */
export type Item<T> = { value: T; cut: false } | { value: T | undefined; cut: true };

/**
 * Runs one item of a job's work in a budget of its own, drawn on the job's:
 * `cut` when one of its calls was refused, so the job gives its claim back
 * instead of recording an outcome that never happened.
 */
export async function item<T>(fn: () => Promise<T>): Promise<Item<T>> {
  const parent = scopes.getStore();
  if (!parent) return { value: await fn(), cut: false };
  const own = parent.child();
  try {
    const value = await scopes.run(own, fn);
    return own.refused > 0 ? { value, cut: true } : { value, cut: false };
  } catch (e) {
    if (own.refused > 0) return { value: undefined, cut: true };
    throw e;
  }
}

/** fetch(), counted against the budget the call runs in. */
export function outboundFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const calls = scopes.getStore();
  if (calls && !calls.take()) return Promise.reject(new CallsSpent());
  return fetch(input, init);
}

/** Whether the budget the caller runs in refused a call: what it read was cut short, not answered. */
export const callsRefused = (): boolean => (scopes.getStore()?.refused ?? 0) > 0;
