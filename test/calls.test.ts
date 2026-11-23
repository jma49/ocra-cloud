import { afterEach, describe, expect, it, vi } from "vitest";
import { CallBudget, item, outboundFetch, withCalls } from "../src/calls.js";
import { runScheduled, WORKER_CALLS, WORKER_SHARES } from "../src/cron-calls.js";

// The budget of external calls a scheduled run shares (src/calls.ts,
// src/cron-calls.ts): each job's share first, then what is left to the jobs
// that wanted more, in order, the work that can wait last.

afterEach(() => vi.restoreAllMocks());

const answered = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));

describe("the scheduled run's budget", () => {
  it("shares out no more than the Free plan's 50, with room", () => {
    const shares = Object.values(WORKER_SHARES).reduce((a, b) => a + b, 0);
    expect(shares).toBe(WORKER_CALLS);
    expect(WORKER_CALLS).toBeLessThanOrEqual(45);
  });

  it("gives a job that wanted more what the others left, the waiting work last", async () => {
    answered();
    const made: Record<string, number> = {};
    const greedy = (name: string, wants: number) => async (calls: CallBudget) => {
      while ((made[name] ?? 0) < wants && calls.has()) {
        await outboundFetch("https://example.test/");
        made[name] = (made[name] ?? 0) + 1;
      }
    };
    const total = await runScheduled({
      deliveries: greedy("deliveries", 30),
      digests: greedy("digests", 1),
      reconcile: greedy("reconcile", 30),
    });
    expect(total).toBe(WORKER_CALLS);
    expect(made.digests).toBe(1);
    expect(made.deliveries).toBe(30);
    expect(made.reconcile).toBe(WORKER_CALLS - 31);
  });

  it("refuses a call past the budget without making it, and marks the item cut", async () => {
    const fetch = answered();
    const calls = new CallBudget(1);
    const first = await withCalls(calls, () => item(() => outboundFetch("https://example.test/")));
    expect(first.cut).toBe(false);
    const second = await withCalls(calls, () =>
      item(async () => {
        await outboundFetch("https://example.test/").catch(() => null);
        return "answered as if the platform failed";
      }),
    );
    expect(second.cut).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls.short).toBe(true);
  });

  it("is plain fetch outside a budget", async () => {
    const fetch = answered();
    for (let i = 0; i < 3; i++)
      expect((await item(() => outboundFetch("https://example.test/"))).cut).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
