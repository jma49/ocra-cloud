import type { ModelPrice } from "@open-cr-agent/cloud-contract";

// The providers' published list prices, in US dollars per million tokens,
// which the CLI counts a review's cost and spend limit with. A model that is
// not here is unpriced there, with a warning; one that is must match the
// provider's price page (checked 2026-11-23).

type Prices = Readonly<Record<string, ModelPrice>>;

export const anthropicPrices: Prices = {
  "claude-fable-5-2": { input: 8, output: 40, cachedInput: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.1 },
  // Its price for prompts of 100K tokens or fewer; a longer prompt costs
  // five times this, which one price per model cannot say.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
};

// What Anthropic charges for writing the five-minute prompt cache, as a
// share of the input price; the engine's Direct runtime counts it alike.
const CACHE_WRITE_FACTOR = 1.25;

/**
 * What a call cost at its model's listed price: input the cache served at
 * the cached price, input written to the cache at the write price, the rest
 * at the input price. `tokensIn` counts all three.
 */
export function callCostUsd(
  price: ModelPrice,
  t: { tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const fresh = Math.max(0, t.tokensIn - t.cacheReadTokens - t.cacheWriteTokens);
  const perMillion =
    fresh * price.input +
    t.cacheWriteTokens * price.input * CACHE_WRITE_FACTOR +
    t.cacheReadTokens * (price.cachedInput ?? price.input) +
    t.tokensOut * price.output;
  return perMillion / 1_000_000;
}

/** The model's price in a provider's list; none for a model it does not list. */
export function priceIn(
  prices: Readonly<Record<string, ModelPrice>> | undefined,
  model: string | null,
): ModelPrice | undefined {
  return prices && model !== null && Object.hasOwn(prices, model) ? prices[model] : undefined;
}
