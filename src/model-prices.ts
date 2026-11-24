import type { ModelPrice } from "@open-cr-agent/cloud-contract";

// The providers' published list prices, in US dollars per million tokens:
// what each gateway call is priced at, and what the CLI counts a review's
// cost and spend limit with. A model that is not here is unpriced, and is
// shown as such; one that is must match the provider's price page (checked
// 2026-11-24).

/** A model's prices for one prompt length, in US dollars per million tokens. */
type RateCard = {
  input: number;
  output: number;
  cacheRead: number;
  /** A write to the five-minute prompt cache. */
  cacheWrite5m: number;
  /** A write to the one-hour prompt cache. */
  cacheWrite1h: number;
};

/** A model's prices; `longPrompt` is what a prompt of more than its `tokens` costs instead. */
export type Rates = RateCard & { longPrompt?: RateCard & { tokens: number } };

/** Names these prices. Kept with each call priced by them, so a later change does not reprice it. */
export const PRICES_VERSION = "2026-11-24";

// Anthropic's cache writes cost 1.25 times the input price for five minutes and twice it for an hour.
const anthropic = (input: number, output: number, cacheRead: number): RateCard => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

export const anthropicRates: Readonly<Record<string, Rates>> = {
  "claude-fable-5-2": anthropic(8, 40, 0.2),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-opus-5": anthropic(5, 25, 0.5),
  "claude-sonnet-5-5": anthropic(2, 10, 0.1),
  "claude-haiku-5-5": {
    ...anthropic(0.1, 0.5, 0.01),
    longPrompt: { ...anthropic(0.5, 2.5, 0.05), tokens: 100_000 },
  },
  "claude-haiku-4-5": anthropic(1, 5, 0.1),
};

/**
 * The one price per model the CLI counts with. Where a model has two, the
 * short prompt's: the CLI's price cannot say that a longer prompt costs more.
 */
export function listPrices(rates: Readonly<Record<string, Rates>>): Record<string, ModelPrice> {
  return Object.fromEntries(
    Object.entries(rates).map(([model, r]) => [
      model,
      { input: r.input, output: r.output, cachedInput: r.cacheRead },
    ]),
  );
}
