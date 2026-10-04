// Shapes the Worker and the web app share. Types only: the web imports this
// file too, so it must not import anything that runs on the Worker.

// The account's settings are the contract's (ADR-0025, ADR-0027): what a
// save keeps, after its schema dropped what sets nothing.
export type {
  AgentPrefs,
  Effort,
  ModelChains,
  ModelTier as Tier,
  ReviewSettings,
  Runtime,
} from "./contract/index.js";

export type Rule = NonNullable<import("./contract/index.js").ReviewSettings["rules"]>[number];

export type ProviderGroup = "Major" | "China" | "Platforms";
