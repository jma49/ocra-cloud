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

/**
 * The `reason` of a forbidden_for_session refusal of a web session whose
 * sign-in is older than RECENT_SIGN_IN_MINUTES: deleting the account,
 * replacing a key or deleting the findings sent needs a fresh sign-in
 * (audit C7). The web offers one.
 */
export const RECENT_SIGN_IN = "recent_sign_in";
export const RECENT_SIGN_IN_MINUTES = 15;

/**
 * What the account decided about a finding in the console. The engine's
 * feedback schema (team memory) will name these words; until it is
 * published they are the cloud's own.
 */
export const FINDING_STATUSES = ["open", "fixed", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Why a finding was dismissed; a dismissal always names one. */
export const DISMISS_REASONS = [
  "false_positive",
  "not_important",
  "wrong_fix",
  "already_known",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
