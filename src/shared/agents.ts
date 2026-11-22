import type { AGENT_ROLES, AgentRole, ModelTier } from "@open-cr-agent/cloud-contract";

// The engine's agents (ADR-0025) as the web's Agents page lists them: the
// built-in reviewers and the roles, each with the tier it runs on unless an
// account or repository sets its model. Plugin reviewers are set in the
// repository's configuration, so they are not here.

export type AgentInfo<Id extends string = string> = { id: Id; tier: ModelTier; hint: string };

export const BUILT_IN_REVIEWERS: readonly AgentInfo[] = [
  { id: "correctness", tier: "standard", hint: "Bugs and broken logic" },
  { id: "security", tier: "standard", hint: "Vulnerabilities and unsafe patterns" },
  { id: "performance", tier: "standard", hint: "Slow paths and waste" },
  { id: "docs", tier: "light", hint: "Docs that no longer match the code" },
  { id: "agents-md", tier: "light", hint: "The repository's AGENTS.md rules" },
];

// The contract's roles, checked by type (a value import would bring zod into
// the web bundle): a role it adds or moves fails to type-check here.
const ROLE_IDS: typeof AGENT_ROLES = ["verifier", "judge", "helper", "writer"];
const ROLE_INFO: Record<AgentRole, Omit<AgentInfo, "id">> = {
  verifier: { tier: "standard", hint: "Checks each finding against the code" },
  judge: { tier: "top", hint: "Deduplicates and calibrates severity" },
  helper: { tier: "light", hint: "Groups files and relocates quotes" },
  writer: { tier: "standard", hint: "Writes the walkthrough and answers @ocra" },
};

/** The agents that are not reviewers, in the contract's order. */
export const ROLES: readonly AgentInfo<AgentRole>[] = ROLE_IDS.map((id) => ({
  id,
  ...ROLE_INFO[id],
}));
