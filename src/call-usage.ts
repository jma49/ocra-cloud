import { PRICES_VERSION, type Rates } from "./model-prices.js";
import type { Provider } from "./providers.js";

// What one model call used, read from the provider's own counts in its
// answer, and what that cost at the model's list price.

export type Usage = {
  /** The whole prompt, the part read from or written to the prompt cache included. */
  tokensIn: number;
  tokensOut: number;
  /** The prompt's tokens read from the cache. */
  cacheRead: number;
  /** The prompt's tokens written to the five-minute cache. */
  cacheWrite5m: number;
  /** The prompt's tokens written to the one-hour cache. */
  cacheWrite1h: number;
};

export const NO_USAGE: Usage = {
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

/**
 * The counts in an answer or stream, each the largest given, since a stream
 * repeats them as they grow. OpenAI-style and Gemini prompt counts include
 * the cached tokens; Anthropic's input_tokens leaves out its cache reads and
 * writes, so they are added. A count inside the model's text never matches:
 * its quotes are escaped there.
 */
export function parseUsage(text: string): Usage {
  const max = (re: RegExp) => {
    let v = 0;
    for (const m of text.matchAll(re)) v = Math.max(v, Number(m[1]));
    return v;
  };
  const read = max(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
  const written = max(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
  // Anthropic splits the writes by how long they are kept; an answer that
  // does not wrote all of them to the five-minute cache.
  const hour = Math.min(written, max(/"ephemeral_1h_input_tokens"\s*:\s*(\d+)/g));
  return {
    tokensIn:
      max(/"(?:prompt_tokens|input_tokens|promptTokenCount)"\s*:\s*(\d+)/g) + read + written,
    tokensOut: max(/"(?:completion_tokens|output_tokens|candidatesTokenCount)"\s*:\s*(\d+)/g),
    cacheRead: read + max(/"(?:cached_tokens|cachedContentTokenCount)"\s*:\s*(\d+)/g),
    cacheWrite5m: written - hour,
    cacheWrite1h: hour,
  };
}

/** Keeps in `into` the larger of each of its counts and `seen`'s, as a stream's counts grow. */
export function keepLargest(into: Usage, seen: Usage): void {
  for (const k of Object.keys(into) as (keyof Usage)[]) into[k] = Math.max(into[k], seen[k]);
}

/** What a call cost, in millionths of a US dollar, and the prices it was counted at. */
export type Priced = { costMicroUsd: number | null; priceVersion: string | null };

/** A server's own endpoint, priced as its MODEL_ENDPOINTS entry says. */
const ENDPOINT_PRICES = "endpoint";

/**
 * What a call cost at its model's list price: nothing for a call that used
 * no tokens, and null, unpriced, for a model without a price.
 */
export function priceCall(
  provider: Pick<Provider, "prices" | "rates">,
  model: string | null,
  usage: Usage,
): Priced {
  if (usage.tokensIn === 0 && usage.tokensOut === 0) return { costMicroUsd: 0, priceVersion: null };
  const found = model === null ? undefined : ratesOf(provider, model);
  if (!found) return { costMicroUsd: null, priceVersion: null };
  const { rates, version } = found;
  const long = rates.longPrompt;
  const card = long && usage.tokensIn > long.tokens ? long : rates;
  const { cacheRead, cacheWrite5m, cacheWrite1h } = usage;
  const uncached = Math.max(0, usage.tokensIn - cacheRead - cacheWrite5m - cacheWrite1h);
  // Tokens at dollars per million tokens come to millionths of a dollar.
  const micro =
    uncached * card.input +
    cacheRead * card.cacheRead +
    cacheWrite5m * card.cacheWrite5m +
    cacheWrite1h * card.cacheWrite1h +
    usage.tokensOut * card.output;
  return { costMicroUsd: Math.round(micro), priceVersion: version };
}

function ratesOf(
  provider: Pick<Provider, "prices" | "rates">,
  model: string,
): { rates: Rates; version: string } | undefined {
  if (provider.rates && Object.hasOwn(provider.rates, model)) {
    const rates = provider.rates[model];
    if (rates) return { rates, version: PRICES_VERSION };
  }
  const price =
    provider.prices && Object.hasOwn(provider.prices, model) ? provider.prices[model] : null;
  if (!price) return undefined;
  // An endpoint's price says nothing of cache writes: they are input.
  const rates: Rates = {
    input: price.input,
    output: price.output,
    cacheRead: price.cachedInput ?? price.input,
    cacheWrite5m: price.input,
    cacheWrite1h: price.input,
  };
  return { rates, version: ENDPOINT_PRICES };
}
