// The domain's words and shapes, shared by the Worker and the web app. Types
// only: the contract's values (its enum arrays) come with its schemas and
// zod, which the web bundle does not carry; the schema takes them from the
// contract itself.

// The account's settings are the contract's (ADR-0025, ADR-0027): what a
// save keeps, after its schema dropped what sets nothing.
// The contract's vocabulary: the words the API stores and answers with.
export type {
  AgentPrefs,
  AgentRole,
  Effort,
  ModelChains,
  ModelTier as Tier,
  ReviewerCounts,
  ReviewSettings,
  ReviewSource,
  RiskTier,
  Runtime,
  Severity,
  Verdict,
  Verification,
} from "@open-cr-agent/cloud-contract";

export type Rule = NonNullable<
  import("@open-cr-agent/cloud-contract").ReviewSettings["rules"]
>[number];

export type ProviderGroup = "Major" | "China" | "Platforms";
