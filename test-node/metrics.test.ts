import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { RUNNER_STALE_MS } from "../src/health.js";
import { bindingsFrom, metricsTokenFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { METRICS } from "../src/node/metrics.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";

// The self-hosted server's operations endpoints: /metrics behind its
// bearer token, in Prometheus' text format, with aggregate series only;
// and the deep health check's runner heartbeat.

const ORIGIN = "http://ocra.test";
const TOKEN = "metrics-token-of-at-least-32-characters";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
};

let dir: string;
let host: Awaited<ReturnType<typeof openHost>>;
let off: Awaited<ReturnType<typeof openHost>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-metrics-"));
  const common = {
    bindings: bindingsFrom(VARS),
    migrations: resolve("migrations"),
    publicUrl: ORIGIN,
  };
  host = await openHost({
    ...common,
    databaseUrl: `file:${join(dir, "ocra.db")}`,
    metrics: { token: TOKEN, engineVersion: "0.12.0" },
    autoReview: {
      bots: { githubApi: GITHUB_COM.api },
      tokens: { forRepo: async () => ({ token: "ghs_bot", login: "ocra-review[bot]" }) },
      workers: 0,
      runnerToken: "runner-token-of-at-least-32-characters",
    },
  });
  off = await openHost({ ...common, databaseUrl: `file:${join(dir, "off.db")}` });
  const account = await upsertAccount(host.db, githubIdentity(1), "secret-login");
  const jobs = scoped(host.db, account.id).autoReview;
  const repo = await jobs.enroll(
    { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/Private" },
    100,
  );
  await jobs.queue(repo ?? "", 7, "c".repeat(40), new Date(Date.now() - 60_000));
});

afterAll(async () => {
  host?.close();
  off?.close();
  await rm(dir, { recursive: true, force: true });
});

const scrape = (token?: string, on = host) =>
  on.fetch(
    new Request(
      `${ORIGIN}/metrics`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    ),
  );

type Series = { name: string; labels: Record<string, string>; value: number };

/** The text exposition format, strictly: HELP and TYPE before each metric's series. */
function parse(text: string): Series[] {
  const typed = new Set<string>();
  const series: Series[] = [];
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) {
    const comment = line.match(/^# (HELP|TYPE) ([a-z_]+) (.+)$/);
    if (comment) {
      if (comment[1] === "TYPE") {
        expect(comment[3]).toMatch(/^(gauge|counter)$/);
        typed.add(comment[2] ?? "");
      }
      continue;
    }
    const sample = line.match(/^([a-z_]+)(?:\{(.*)\})? (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/);
    if (!sample) throw new Error(`not an exposition line: ${line}`);
    const name = sample[1] ?? "";
    expect(typed.has(name)).toBe(true);
    const labels: Record<string, string> = {};
    for (const pair of (sample[2] ?? "").split(",").filter(Boolean)) {
      const m = pair.match(/^([a-z_]+)="((?:[^"\\]|\\.)*)"$/);
      if (!m) throw new Error(`not a label: ${pair}`);
      labels[m[1] ?? ""] = m[2] ?? "";
    }
    series.push({ name, labels, value: Number(sample[3]) });
  }
  return series;
}

describe("GET /metrics", () => {
  it("is not found without METRICS_TOKEN", async () => {
    expect((await scrape(TOKEN, off)).status).toBe(404);
  });

  it("refuses a scrape without the token or with another", async () => {
    for (const token of [undefined, "", "wrong", `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await scrape(token);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("ocra_");
    }
  });

  it("answers aggregate series in the text format, labelled by queue, kind and state only", async () => {
    const res = await scrape(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    const series = parse(text);
    for (const leak of ["secret-login", "Octo/Private", "octo/private"]) {
      expect(text).not.toContain(leak);
    }
    for (const { name, labels } of series) {
      const known = METRICS[name as keyof typeof METRICS];
      expect(known, name).toBeDefined();
      expect(known.labels).toEqual(expect.arrayContaining(Object.keys(labels)));
    }
    const one = (name: string, labels: Record<string, string> = {}) =>
      series.find((s) => s.name === name && JSON.stringify(s.labels) === JSON.stringify(labels));
    expect(one("ocra_jobs", { queue: "review", state: "queued" })?.value).toBe(1);
    expect(one("ocra_jobs_oldest_queued_seconds", { queue: "review" })?.value).toBeGreaterThan(50);
    expect(one("ocra_process_uptime_seconds")?.value).toBeGreaterThanOrEqual(0);
    expect(series.find((s) => s.name === "ocra_build_info")?.labels).toMatchObject({
      engine: "0.12.0",
    });
    expect(
      series.filter((s) => s.name === "ocra_metrics_collector_up").map((s) => s.value),
    ).toEqual([1, 1, 1]);
  });

  it("refuses a METRICS_TOKEN too short to guess at", () => {
    expect(() => metricsTokenFrom("short")).toThrow(/at least 32/);
    expect(metricsTokenFrom(undefined)).toBeUndefined();
    expect(metricsTokenFrom(TOKEN)).toBe(TOKEN);
  });
});

describe("the deep health check on Node", () => {
  const deep = async () => {
    const res = await host.fetch(new Request(`${ORIGIN}/api/health?deep=1`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("passes before any remote runner reported in", async () => {
    expect(await deep()).toMatchObject({ status: 200, body: { ok: true, runnerSeenAt: null } });
  });

  it("fails once every runner heard from has gone quiet", async () => {
    const seen = new Date(Date.now() - RUNNER_STALE_MS - 60_000);
    await host.db
      .insert(schema.reviewRunners)
      .values({ name: "mini", version: "0.12.0", lastSeenAt: seen });
    expect(await deep()).toMatchObject({
      status: 503,
      body: { ok: false, reasons: ["runner_stale"], runnerSeenAt: seen.toISOString() },
    });
    await host.db
      .insert(schema.reviewRunners)
      .values({ name: "new", version: "0.12.0", lastSeenAt: new Date() });
    expect((await deep()).status).toBe(200);
  });
});
