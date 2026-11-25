import { cleanRefactorScenario } from "./clean-refactor.js";
import { forkGateScenario } from "./fork-gate.js";
import { sessionTtlScenario } from "./session-ttl.js";
import type { DemoScenario } from "./types.js";

export type { DemoScenario };

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  sessionTtlScenario,
  forkGateScenario,
  cleanRefactorScenario,
];
