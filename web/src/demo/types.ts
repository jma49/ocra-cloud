import type { LiveEventView } from "../../../src/shared/index.js";

// Recorded live review streams for the public /demo console: real event
// shapes folded by web/src/live/fold.ts. Sample repository names and
// recorded/synthetic runs only (AGENTS.md, Show only what exists).

export type DemoScenario = {
  id: string;
  tab: string;
  repo: string;
  prNumber: number;
  title: string;
  summary: string;
  source: "github" | "gitlab" | "local";
  runId: string;
  events: readonly (LiveEventView & { delayMs: number })[];
};

export const demoTime = (sec: number) => new Date(Date.UTC(2026, 10, 24, 18, 0, sec)).toISOString();
