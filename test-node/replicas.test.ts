import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bindingsFrom, migrateMode } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { databaseRateLimit, rateLimitStore } from "../src/node/limits.js";

// Several server processes on one database (RATE_LIMITS=database): the rate
// limits count for the deployment, and one run applies the migrations.

const ORIGIN = "http://ocra.test";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
};

type Host = Awaited<ReturnType<typeof openHost>>;
let dir: string;
let first: Host;
let second: Host;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-replicas-"));
  const shared = {
    databaseUrl: `file:${join(dir, "ocra.db")}`,
    bindings: bindingsFrom(VARS),
    migrations: resolve("migrations"),
    rateLimits: "database" as const,
  };
  first = await openHost(shared);
  second = await openHost({ ...shared, migrate: false });
});

afterAll(async () => {
  first?.close();
  second?.close();
  await rm(dir, { recursive: true, force: true });
});

const askForCode = (target: Host) =>
  target.fetch(
    new Request(`${ORIGIN}/api/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { incoming: { socket: { remoteAddress: "198.51.100.7" } } },
  );

describe("servers sharing a database", () => {
  it("count the login code limit together", async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await askForCode(i % 2 ? second : first)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("count a limit per key and start again once its window is over", async () => {
    const a = databaseRateLimit(first.db, "test", 2, 60);
    const b = databaseRateLimit(second.db, "test", 2, 60);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const seen = [];
    for (const limit of [a, b, a]) seen.push((await limit.limit({ key: "k" })).success);
    expect(seen).toEqual([true, true, false]);
    expect((await b.limit({ key: "other" })).success).toBe(true);
    now.mockReturnValue(1_000_000 + 60_000);
    expect((await b.limit({ key: "k" })).success).toBe(true);
    now.mockRestore();
  });

  it("leave the migrations to one run when told to", async () => {
    const url = `file:${join(dir, "empty.db")}`;
    const idle = await openHost({
      databaseUrl: url,
      bindings: bindingsFrom(VARS),
      migrations: resolve("migrations"),
      migrate: false,
    });
    idle.close();
    const client = createClient({ url });
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    client.close();
    expect(tables.rows).toEqual([]);
  });

  it("read their switches, refusing what they do not know", () => {
    expect(rateLimitStore(undefined)).toBe("memory");
    expect(rateLimitStore("database")).toBe("database");
    expect(() => rateLimitStore("redis")).toThrow("memory or database");
    expect(migrateMode(undefined)).toBe("on");
    expect(migrateMode("only")).toBe("only");
    expect(() => migrateMode("yes")).toThrow("on, off or only");
  });
});
