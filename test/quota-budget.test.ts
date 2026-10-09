/// <reference types="vite/client" />
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_FINDINGS } from "@open-cr-agent/cloud-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_DAYS } from "../src/db/retention.js";
import app from "../src/index.js";
import wrangler from "../wrangler.jsonc?raw";
import { type CallInit, call, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";
import { type Meter, metered } from "./metered.js";

// Audit C1: on the Workers Free plan, D1's rows read and written and the
// Worker's requests are daily quotas of the whole Cloudflare account, and
// past one D1 fails every query until 00:00 UTC. So one account at its own
// caps must not use them up for everyone: a cap is checked without reading
// the account's records, a refusal writes nothing, and the deployed caps,
// multiplied by what each request costs as measured here, leave room.

/** Workers Free, per UTC day and Cloudflare account (Workers and D1 pricing pages, 2026-10-09). */
const FREE = { rowsWritten: 100_000, rowsRead: 5_000_000, requests: 100_000 };
/** Accounts at every cap on the same day... */
const HEAVY_ACCOUNTS = 5;
/** ...must fit in this share of each quota, leaving the rest to everyone else. */
const SHARE = 0.5;
/** Per account: sessions in use all day (a browser and two terminals), each writing its last use every 5 minutes. */
const SESSIONS = 3;
const LAST_USED_WRITES = SESSIONS * 288;
/** Per account: a terminal's hourly token refresh, for two terminals. */
const REFRESHES = 2 * 24;

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** The vars wrangler.jsonc deploys; the tests run with their own. */
function deployed(): Record<string, string> {
  // Whole-line comments only: JSON.parse fails loudly on anything else.
  return JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")).vars;
}

/** A request's answer and the D1 rows it read and wrote, its waitUntil work included. */
async function measure(path: string, init: CallInit, vars: Record<string, string> = {}) {
  const { DB, meter } = metered();
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), { ...env, ...vars, DB }, ctx);
  const body = (await res.json()) as Record<string, unknown>;
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, ...(meter as Meter) };
}

const finding = (i: number) => ({
  fingerprint: `fp-${i}`,
  reviewer: "security",
  severity: "warning",
  file: `src/f${i}.ts`,
  title: `Finding ${i}`,
  body: "Body.",
});
const upload = (runId: string, n = 0) => ({
  method: "POST",
  json: {
    runId,
    repoHash: "e".repeat(64),
    source: "local",
    findings: { critical: 0, warning: n, suggestion: 0 },
    findingList: Array.from({ length: n }, (_, i) => finding(i)),
  },
});

/** A CLI session of an account that shares findings. */
async function sharing() {
  const web = await signIn(1, "octo");
  await call("/api/account/sharing", {
    method: "PUT",
    auth: web.auth,
    headers: { origin: ORIGIN },
    json: { enabled: true },
  });
  return (await signInCli(1, "octo")).auth;
}

/** A web session with a stored key, and a fake provider that answers every call. */
async function gatewayUser() {
  const { auth } = await signIn(1, "octo");
  await call("/api/keys/openrouter", { method: "PUT", auth, json: { key: "sk-or-0123456789" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  );
  return auth;
}
const modelCall = {
  method: "POST",
  json: { model: "vendor/model", messages: [{ role: "user", content: "hi" }] },
};
const GATEWAY = "/api/gateway/openrouter/v1/chat/completions";
/**
 * An index lookup reads the entry after its last match when there is one,
 * so the same request can read a row or two more as neighbours appear; a
 * count over the account's records reads hundreds more here.
 */
const SEEK_SLACK = 2;

describe("checking a cap", () => {
  it("reads and writes as many rows for an upload whatever the account shared before", async () => {
    const auth = await sharing();
    await call("/api/reviews", { ...upload("warm", 1), auth });
    const first = await measure("/api/reviews", { ...upload("first", 10), auth });
    for (const run of ["b1", "b2", "b3", "b4"]) {
      await call("/api/reviews", { ...upload(run, MAX_FINDINGS), auth });
    }
    const later = await measure("/api/reviews", { ...upload("later", 10), auth });
    expect(later.body).toMatchObject({ findings: 10 });
    expect(later.written).toBe(first.written);
    expect(later.read).toBeLessThanOrEqual(first.read + SEEK_SLACK);
  });

  it("reads and writes as many rows for a gateway call whatever the account called today", async () => {
    const auth = await gatewayUser();
    const vars = { GATEWAY_DAILY_CALLS: "100" };
    await measure(GATEWAY, { ...modelCall, auth }, vars);
    const first = await measure(GATEWAY, { ...modelCall, auth }, vars);
    for (let i = 0; i < 20; i++) await measure(GATEWAY, { ...modelCall, auth }, vars);
    const later = await measure(GATEWAY, { ...modelCall, auth }, vars);
    expect(later.status).toBe(200);
    expect(later.written).toBe(first.written);
    expect(later.read).toBeLessThanOrEqual(first.read + SEEK_SLACK);
  });

  it("writes nothing when it refuses", async () => {
    const auth = await sharing();
    const one = { REVIEW_DAILY_UPLOADS: "1" };
    expect((await measure("/api/reviews", { ...upload("a", 3), auth }, one)).status).toBe(200);
    const refused = await measure("/api/reviews", { ...upload("b", 3), auth }, one);
    expect(refused).toMatchObject({ status: 429, written: 0 });

    const web = await gatewayUser();
    const calls = { GATEWAY_DAILY_CALLS: "1" };
    expect((await measure(GATEWAY, { ...modelCall, auth: web }, calls)).status).toBe(200);
    const capped = await measure(GATEWAY, { ...modelCall, auth: web }, calls);
    expect(capped).toMatchObject({ status: 429, written: 0 });
  });
});

describe("the deployed caps", () => {
  it(`keep ${HEAVY_ACCOUNTS} accounts at every cap within ${SHARE * 100}% of each Free quota`, async () => {
    // What one request of each kind costs, measured on a warm session.
    const auth = await sharing();
    await call("/api/reviews", { ...upload("warm"), auth });
    const bare = await measure("/api/reviews", { ...upload("bare"), auth });
    const full = await measure("/api/reviews", { ...upload("full", MAX_FINDINGS), auth });
    const perFinding = (full.written - bare.written) / MAX_FINDINGS;
    const web = await gatewayUser();
    await measure(GATEWAY, { ...modelCall, auth: web });
    const gateway = await measure(GATEWAY, { ...modelCall, auth: web });
    const { tokens } = await signInCli(2, "hubot");
    const refresh = await measure("/api/device/refresh", {
      method: "POST",
      json: { refresh_token: tokens.refresh_token },
    });
    expect([bare.status, full.status, gateway.status, refresh.status]).toEqual([
      200, 200, 200, 200,
    ]);

    const caps = deployed();
    const uploads = Number(caps.REVIEW_DAILY_UPLOADS);
    const calls = Number(caps.GATEWAY_DAILY_CALLS);
    // Findings count over the retention window: all of them may come in one day.
    const findings = Math.min(Number(caps.REVIEW_MAX_FINDINGS), uploads * MAX_FINDINGS);
    const daily = uploads * bare.written + calls * gateway.written + REFRESHES * refresh.written;
    const perAccount = {
      // The day an account sends its whole findings allowance.
      written: daily + findings * perFinding + LAST_USED_WRITES,
      // Every day at the daily caps: what was written RETENTION_DAYS ago is
      // deleted, row for row, so the inserts count twice.
      writtenSteady: 2 * (daily + (findings / RETENTION_DAYS) * perFinding) + LAST_USED_WRITES,
      read: uploads * full.read + calls * gateway.read + REFRESHES * refresh.read,
      requests: uploads + calls + REFRESHES,
    };
    const budget = {
      written: SHARE * FREE.rowsWritten,
      writtenSteady: SHARE * FREE.rowsWritten,
      read: SHARE * FREE.rowsRead,
      requests: SHARE * FREE.requests,
    };
    for (const [what, n] of Object.entries(perAccount)) {
      const total = HEAVY_ACCOUNTS * n;
      const limit = budget[what as keyof typeof budget];
      expect(total, `${what}: ${HEAVY_ACCOUNTS} x ${n} > ${limit}`).toBeLessThanOrEqual(limit);
    }
  });
});
