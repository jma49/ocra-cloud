import { describe, expect, it } from "vitest";
import { NO_USAGE, parseUsage, priceCall, type Usage } from "../src/call-usage.js";
import { anthropicRates, PRICES_VERSION } from "../src/model-prices.js";

const usage = (u: Partial<Usage>): Usage => ({ ...NO_USAGE, ...u });

describe("parseUsage", () => {
  it("reads OpenAI, Responses and Anthropic counts", () => {
    expect(parseUsage('{"usage":{"prompt_tokens":5,"completion_tokens":7}}')).toEqual(
      usage({ tokensIn: 5, tokensOut: 7 }),
    );
    expect(parseUsage('{"usage":{"input_tokens":9,"output_tokens":2}}')).toEqual(
      usage({ tokensIn: 9, tokensOut: 2 }),
    );
    const anthropic =
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":300,"output_tokens":1}}}\n' +
      '...\nevent: message_delta\ndata: {"usage":{"output_tokens":45}}\n';
    expect(parseUsage(anthropic)).toEqual(usage({ tokensIn: 300, tokensOut: 45 }));
    expect(parseUsage("no counts")).toEqual(NO_USAGE);
  });

  it("adds Anthropic's cache reads and writes to the input count, and keeps them apart", () => {
    const anthropic =
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,' +
      '"cache_creation_input_tokens":2000,"cache_read_input_tokens":30000,"output_tokens":1}}}\n' +
      '...\nevent: message_delta\ndata: {"usage":{"output_tokens":45}}\n';
    expect(parseUsage(anthropic)).toEqual({
      tokensIn: 32_012,
      tokensOut: 45,
      cacheRead: 30_000,
      cacheWrite5m: 2_000,
      cacheWrite1h: 0,
    });
  });

  it("splits Anthropic's cache writes into the five-minute and the one-hour cache", () => {
    const answer = JSON.stringify({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 700,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
        cache_read_input_tokens: 0,
        output_tokens: 3,
      },
    });
    expect(parseUsage(answer)).toMatchObject({
      tokensIn: 710,
      cacheWrite5m: 200,
      cacheWrite1h: 500,
    });
  });

  it("takes OpenAI's and Gemini's cached tokens as reads already in the prompt count", () => {
    expect(
      parseUsage(
        '{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":5}}',
      ),
    ).toEqual(usage({ tokensIn: 100, tokensOut: 5, cacheRead: 80 }));
    expect(
      parseUsage(
        '{"usageMetadata":{"promptTokenCount":50,"cachedContentTokenCount":40,"candidatesTokenCount":2}}',
      ),
    ).toEqual(usage({ tokensIn: 50, tokensOut: 2, cacheRead: 40 }));
  });

  it("never reads a count from the model's own text", () => {
    const text = JSON.stringify({ delta: { text: '{"output_tokens": 999999}' } });
    expect(parseUsage(text)).toEqual(NO_USAGE);
  });
});

describe("priceCall", () => {
  const anthropic = { rates: anthropicRates };

  it("prices each kind of token at its own rate", () => {
    // Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 and $8 cache writes.
    const priced = priceCall(
      anthropic,
      "claude-opus-5-5",
      usage({
        tokensIn: 1_000_000 + 2_000_000 + 100_000 + 10_000,
        cacheRead: 2_000_000,
        cacheWrite5m: 100_000,
        cacheWrite1h: 10_000,
        tokensOut: 50_000,
      }),
    );
    expect(priced).toEqual({
      costMicroUsd: 4_000_000 + 400_000 + 500_000 + 80_000 + 1_000_000,
      priceVersion: PRICES_VERSION,
    });
  });

  it("prices a long prompt at the model's long-prompt rates", () => {
    const short = priceCall(anthropic, "claude-haiku-5-5", usage({ tokensIn: 100_000 }));
    const long = priceCall(anthropic, "claude-haiku-5-5", usage({ tokensIn: 100_001 }));
    expect(short.costMicroUsd).toBe(10_000);
    expect(long.costMicroUsd).toBe(50_001);
  });

  it("leaves a model without a price unpriced, and a call that used nothing at nothing", () => {
    expect(priceCall(anthropic, "claude-unknown", usage({ tokensIn: 5 }))).toEqual({
      costMicroUsd: null,
      priceVersion: null,
    });
    expect(priceCall(anthropic, null, usage({ tokensOut: 5 })).costMicroUsd).toBeNull();
    expect(priceCall(anthropic, "claude-unknown", NO_USAGE)).toEqual({
      costMicroUsd: 0,
      priceVersion: null,
    });
    expect(priceCall(anthropic, "__proto__", usage({ tokensIn: 5 })).costMicroUsd).toBeNull();
  });

  it("prices a server's own endpoint at the price its settings give", () => {
    const endpoint = { prices: { "local-model": { input: 1, output: 2, cachedInput: 0.5 } } };
    expect(
      priceCall(
        endpoint,
        "local-model",
        usage({ tokensIn: 300, cacheRead: 100, tokensOut: 10, cacheWrite5m: 100 }),
      ),
    ).toEqual({ costMicroUsd: 100 + 50 + 100 + 20, priceVersion: "endpoint" });
  });
});
