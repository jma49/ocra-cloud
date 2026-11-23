import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresHub } from "../src/node/pull-events-pg.js";
import type { PullsChangedEvent } from "../src/shared/index.js";
import { type RealPostgres, realPostgresAvailable, startRealPostgres } from "./real-postgres.js";

// One process's end of the streams' channel on Postgres: it listens again
// after losing its connection, and without one it tells its own streams.

let server: RealPostgres | undefined;
const available = realPostgresAvailable();

beforeAll(async () => {
  if (available) server = await startRealPostgres();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!available)("a process's Postgres hub", () => {
  it("listens again after its connection is lost, and ends its streams to catch up", async () => {
    if (!server) throw new Error("no server");
    const pool = new pg.Pool({ connectionString: server.url });
    const x = await postgresHub(server.url, pool, { retryMs: 20 });
    const y = await postgresHub(server.url, pool, { retryMs: 20 });
    try {
      expect(x.listening() && y.listening()).toBe(true);
      const before = await x.listen("acct", () => {});
      if (before === "full") throw new Error("full");
      await pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN ocra_pulls_changed'",
      );
      await before.closed;
      await vi.waitFor(() => expect(x.listening() && y.listening()).toBe(true), { timeout: 5_000 });
      const got: PullsChangedEvent[][] = [];
      await x.listen("acct", (events) => got.push(events));
      const event = { repoId: "r", number: 1, kind: "pull" } as const;
      await y.publish("acct", [event]);
      await vi.waitFor(() => expect(got).toEqual([[event]]));
    } finally {
      x.stop();
      y.stop();
      await pool.end();
    }
  });
});

describe("a process whose LISTEN fails", () => {
  it("tells its own streams, and logs it once without the address", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const notified: unknown[][] = [];
    const pool = {
      query: async (...args: unknown[]) => {
        notified.push(args);
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    // Port 1 answers no Postgres.
    const hub = await postgresHub("postgres://ocra:hunter2@127.0.0.1:1/ocra", pool, {
      retryMs: 5,
    });
    try {
      expect(hub.listening()).toBe(false);
      const got: PullsChangedEvent[][] = [];
      await hub.listen("acct", (events) => got.push(events));
      const event = { repoId: null, number: null, kind: "review" } as const;
      await hub.publish("acct", [event]);
      expect(got).toEqual([[event]]);
      expect(notified).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 100));
      const lines = logged.mock.calls.filter((c) => JSON.stringify(c).includes("pull_events"));
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain("hunter2");
      expect(JSON.stringify(lines)).not.toContain("127.0.0.1");
    } finally {
      hub.stop();
    }
  });
});
