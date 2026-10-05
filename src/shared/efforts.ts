import type { Effort } from "@open-cr-agent/cloud-contract";

// Which reasoning effort levels a model takes (ADR-0025), for the web's
// Agents page: it offers only these. The engine never refuses a level on
// this table's account; it is a hint that goes stale as models ship, so
// OpenRouter's live `supported_parameters` wins where it is known.

const LMH: Effort[] = ["low", "medium", "high"];

const PATTERNS: [RegExp, Effort[]][] = [
  // OpenAI reasoning models: o-series and GPT-5.
  [/(^|\/)(o[1-9](-mini|-pro)?|gpt-5[\w.-]*)$/, ["minimal", "low", "medium", "high"]],
  // Anthropic models with extended thinking (budgets mapped from the level).
  [/claude-[\w.-]*(opus|sonnet|haiku)-?[4-9]|claude-(opus|sonnet|haiku)-[4-9]/, LMH],
  // Gemini 2.5 and 3: Flash can also turn thinking off.
  [/gemini-(2\.5|3)[\w.-]*flash/, ["none", ...LMH]],
  [/gemini-(2\.5|3)[\w.-]*pro/, LMH],
  [/grok-(3-mini|4)/, ["low", "high"]],
];

export function effortLevels(model: string, live?: { reasoning: boolean }): Effort[] {
  if (live) return live.reasoning ? LMH : [];
  const id = model.toLowerCase();
  for (const [pattern, levels] of PATTERNS) if (pattern.test(id)) return [...levels];
  return [];
}
