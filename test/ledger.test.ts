import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { PRICES_VERSION } from "../src/model-prices.js";
import { DAY, utcDay } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const ANTHROPIC_KEY = "sk-ant-0123456789abcdef";

async function withAnthropicKey(githubId = 1) {
  const user = await signIn(githubId, `u${githubId}`);
  const res = await call("/api/keys/anthropic", {
    method: "PUT",
    auth: user.auth,
    json: { key: ANTHROPIC_KEY },
  });
  expect(res.status).toBe(200);
  return user;
}

function answer(json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(json));
}

const messages = (auth: Record<string, string>, path = "/v1/messages") =>
  call(`/api/gateway/anthropic${path}`, {
    method: "POST",
    auth,
    json: { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] },
  });

describe("the gateway's ledger", () => {
  it("records each kind of token a call used and what it cost at the model's list price", async () => {
    const { auth, account } = await withAnthropicKey();
    answer({
      usage: {
        input_tokens: 1_000,
        cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
        cache_read_input_tokens: 10_000,
        output_tokens: 500,
      },
    });
    expect((await messages(auth)).status).toBe(200);
    const [recorded] = await scoped(db, account.id).list("gatewayCalls");
    // Sonnet 5.5: $2 input, $0.10 cache read, $2.50 and $4 cache writes, $10 output.
    expect(recorded).toMatchObject({
      model: "claude-sonnet-5-5",
      tokensIn: 14_000,
      cacheRead: 10_000,
      cacheWrite5m: 2_000,
      cacheWrite1h: 1_000,
      tokensOut: 500,
      costMicroUsd: 2_000 + 1_000 + 5_000 + 4_000 + 5_000,
      priceVersion: PRICES_VERSION,
    });
  });

  it("records counting a prompt's tokens as using none", async () => {
    const { auth, account } = await withAnthropicKey();
    answer({ input_tokens: 90_000 });
    expect((await messages(auth, "/v1/messages/count_tokens")).status).toBe(200);
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([
      { tokensIn: 0, tokensOut: 0, costMicroUsd: 0 },
    ]);
  });
});

/** A call recorded `daysAgo` days before now. */
function recorded(accountId: string, daysAgo: number, fields: Record<string, unknown>) {
  return scoped(db, accountId).insert("gatewayCalls", {
    provider: "anthropic",
    path: "/v1/messages",
    model: "claude-sonnet-5-5",
    status: 200,
    createdAt: new Date(Date.now() - daysAgo * DAY),
    ...fields,
  });
}

describe("the ledger view", () => {
  it("sums the month's calls by UTC day and model, with the unpriced ones counted apart", async () => {
    const { auth, account } = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await recorded(account.id, 0, {
      tokensIn: 1_300,
      cacheRead: 200,
      cacheWrite5m: 100,
      tokensOut: 40,
      costMicroUsd: 1_500,
    });
    await recorded(account.id, 0, { tokensIn: 10, tokensOut: 5, costMicroUsd: 70, status: 529 });
    await recorded(account.id, 0, { model: "vendor/unpriced", tokensIn: 9, costMicroUsd: null });
    await recorded(account.id, 0, { model: "vendor/unpriced", status: 0, costMicroUsd: null });
    await recorded(other.account.id, 0, { tokensIn: 5, costMicroUsd: 999 });
    const month = utcDay(new Date()).slice(0, 7);
    const res = await call(`/api/ledger?month=${month}`, { auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; months: string[]; rows: unknown[] };
    expect(body.month).toBe(month);
    expect(body.months[0]).toBe(month);
    expect(body.rows).toEqual([
      {
        day: utcDay(new Date()),
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        calls: 2,
        failed: 1,
        input: 1_010,
        cacheWrite5m: 100,
        cacheWrite1h: 0,
        cacheRead: 200,
        output: 45,
        costUsd: 0.00157,
        unpriced: 0,
      },
      expect.objectContaining({ model: "vendor/unpriced", calls: 2, costUsd: 0, unpriced: 1 }),
    ]);
  });

  it("gives the month as a CSV a spreadsheet reads safely", async () => {
    const { auth, account } = await signIn(1, "octo");
    await recorded(account.id, 0, { tokensIn: 100, tokensOut: 10, costMicroUsd: 300 });
    await recorded(account.id, 0, { model: '=HYPERLINK("x"),y', tokensIn: 1, costMicroUsd: null });
    const month = utcDay(new Date()).slice(0, 7);
    const res = await call(`/api/ledger/csv?month=${month}`, { auth });
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`ocra-usage-${month}.csv`);
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "usage_date_utc,provider,model,calls,failed_calls,input_tokens_no_cache," +
        "input_tokens_cache_write_5m,input_tokens_cache_write_1h,input_tokens_cache_read," +
        "output_tokens,cost_usd,unpriced_calls",
    );
    const today = utcDay(new Date());
    expect(lines).toContain(`${today},anthropic,"'=HYPERLINK(""x""),y",1,0,1,0,0,0,0,0.000000,1`);
    expect(lines).toContain(`${today},anthropic,claude-sonnet-5-5,1,0,100,0,0,0,10,0.000300,0`);
  });

  it("refuses a month that is malformed, to come or no longer kept", async () => {
    const { auth } = await signIn(1, "octo");
    for (const month of ["2026-13", "november", "2999-01", "2001-01"]) {
      expect((await call(`/api/ledger?month=${month}`, { auth })).status).toBe(404);
      expect((await call(`/api/ledger/csv?month=${month}`, { auth })).status).toBe(404);
    }
  });
});

describe("Insights spend", () => {
  it("is what the account's calls cost on each UTC day of the period", async () => {
    const { auth, account } = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await recorded(account.id, 0, { tokensIn: 1, costMicroUsd: 1_250_000 });
    await recorded(account.id, 0, { tokensIn: 1, costMicroUsd: 500_000 });
    await recorded(account.id, 0, { model: "vendor/unpriced", tokensIn: 1, costMicroUsd: null });
    await recorded(account.id, 9, { tokensIn: 1, costMicroUsd: 4_000_000 });
    await recorded(other.account.id, 0, { tokensIn: 1, costMicroUsd: 7_000_000 });
    const list = (await (await call("/api/reviews?days=7", { auth })).json()) as {
      spend: unknown;
      unpricedCalls: number;
    };
    expect(list.spend).toEqual([{ day: utcDay(new Date()), usd: 1.75 }]);
    expect(list.unpricedCalls).toBe(1);
  });
});
