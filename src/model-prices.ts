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
