import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { callCostUsd } from "../src/model-prices.js";
import type { GatewaySpendView } from "../src/shared/index.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HASH = "b".repeat(64);
const KEY = "sk-ant-0123456789abcdef";

function anthropicAnswer(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 10_000,
          output_tokens: 1,
        },
      },
    },
    { type: "message_delta", usage: { output_tokens: 500 } },
  ];
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

async function signedIn() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => anthropicAnswer());
  const web = await signIn(1, "octo");
  const res = await call("/api/keys/anthropic", {
    method: "PUT",
    auth: web.auth,
    json: { key: KEY },
  });
  expect(res.status).toBe(200);
  return { web, cli: await signInCli(1, "octo") };
}

const viaGateway = (auth: Record<string, string>) =>
  call("/api/gateway/anthropic/v1/messages", {
    method: "POST",
    auth,
    json: { model: "claude-sonnet-5-5", stream: true, max_tokens: 64, messages: [] },
  }).then((r) => r.text());

const upload = (auth: Record<string, string>, runId: string, costUsd: number) =>
  call("/api/reviews", {
    method: "POST",
    auth,
    json: {
      runId,
      repoHash: HASH,
      source: "github",
      tier: "lite",
      verdict: "approved",
      complete: true,
      findings: { critical: 0, warning: 0, suggestion: 0 },
      files: { reviewed: 1, notReviewed: 0 },
      tasks: { completed: 1, failed: 0 },
      usage: { inputTokens: 3_000, outputTokens: 500, costUsd },
      durationMs: 60_000,
      ocraVersion: "0.24.0",
    },
  });

async function spendOf(auth: Record<string, string>) {
  const body = (await (await call("/api/reviews", { auth })).json()) as {
    summary: { costUsd: number };
    gateway?: GatewaySpendView;
  };
  return { reviews: body.summary.costUsd, gateway: body.gateway };
}

describe("gateway spend", () => {
  it("prices a call at the model's listed price, cache reads and writes apart", async () => {
    const { web, cli } = await signedIn();
    await viaGateway(cli.auth);
    const [recorded] = await scoped(db, web.account.id).list("gatewayCalls");
    expect(recorded).toMatchObject({
      model: "claude-sonnet-5-5",
      tokensIn: 13_000,
      tokensOut: 500,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
      origin: "run",
      sessionId: expect.any(String),
    });
    // 1,000 fresh at $2, 2,000 written at $2.50, 10,000 read at $0.10, 500 out at $10 a million.
    expect(recorded?.costUsd).toBeCloseTo(0.013, 9);
  });

  it("counts a run's calls in Insights until its review claims them", async () => {
    const { web, cli } = await signedIn();
    await viaGateway(cli.auth);
    expect((await spendOf(web.auth)).gateway).toMatchObject({ calls: 1, unpriced: 0 });
    expect((await spendOf(web.auth)).gateway?.costUsd).toBeCloseTo(0.013, 9);

    expect((await upload(cli.auth, "run-claims", 0.02)).status).toBe(200);
    const after = await spendOf(web.auth);
    expect(after.reviews).toBeCloseTo(0.02, 9);
    expect(after.gateway).toMatchObject({ costUsd: 0, calls: 0, days: [] });
  });

  it("leaves another session's calls unclaimed", async () => {
    const { web, cli } = await signedIn();
    await viaGateway(cli.auth);
    const other = await signInCli(1, "octo");
    expect((await upload(other.auth, "run-other", 0.02)).status).toBe(200);
    expect((await spendOf(web.auth)).gateway).toMatchObject({ calls: 1 });
  });

  it("adds ocra Cloud's own calls and counts the unpriced apart", async () => {
    const web = await signIn(2, "hubot");
    const data = scoped(db, web.account.id);
    await data.insert("gatewayCalls", {
      ...rows.gatewayCalls("explain"),
      origin: "console",
      tokensIn: 100,
      costUsd: 0.25,
    });
    await data.insert("gatewayCalls", { ...rows.gatewayCalls("old"), tokensIn: 5_000 });
    const today = new Date().toISOString().slice(0, 10);
    expect((await spendOf(web.auth)).gateway).toEqual({
      costUsd: 0.25,
      calls: 2,
      console: 1,
      unpriced: 1,
      days: [{ day: today, costUsd: 0.25 }],
    });
  });
});

describe("callCostUsd", () => {
  it("prices cached input at the cached rate, or at the input rate when none is listed", () => {
    const tokens = {
      tokensIn: 1_000_000,
      tokensOut: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(callCostUsd({ input: 2, output: 10, cachedInput: 0.1 }, tokens)).toBeCloseTo(0.1, 9);
    expect(callCostUsd({ input: 2, output: 10 }, tokens)).toBeCloseTo(2, 9);
  });
});
