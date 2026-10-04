// Shapes the Worker and the web app share. Types only: the web imports this
// file too, so it must not import anything that runs on the Worker.

import type { Effort, ModelTier as Tier } from "./contract/index.js";

export type { Effort, ModelTier as Tier, Runtime } from "./contract/index.js";

export type ModelChains = Partial<Record<Tier, string[]>>;

export type AgentPrefs = {
  effort?: Partial<Record<Tier, Effort>>;
  reviewers?: Record<string, { enabled?: boolean; models?: string[]; effort?: Effort }>;
  roles?: Partial<Record<"verifier" | "judge" | "helper", { models?: string[]; effort?: Effort }>>;
};

export type Rule = { path: string | string[]; rule: string };

/** The review's data settings (ADR-0027): never providers, extends or botLogin. */
export type ReviewSettings = {
  ultra?: boolean;
  concurrency?: number;
  taskTimeoutMinutes?: number;
  runTimeoutMinutes?: number;
  maxCostUsd?: number;
  maxTasks?: number;
  verify?: boolean;
  judge?: boolean;
  sampling?: { temperature?: number; seed?: number };
  include?: string[];
  exclude?: string[];
  rules?: Rule[];
  plugins?: string[];
  pluginSettings?: Record<string, unknown>;
};

export type ProviderGroup = "Major" | "China" | "Platforms";
