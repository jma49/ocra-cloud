import type { Severity } from "@open-cr-agent/cloud-contract";
import { REVIEW_DEPTH_SETTINGS, type ReviewDepth } from "../shared/index.js";

type DepthConfig = {
  reviewers?: Record<string, { enabled: false }>;
  showPreExisting?: boolean;
  minInlineSeverity?: Severity;
  maxInlineComments?: number;
  ultra?: false;
};

/**
 * What a hosted review's depth adds: the engine's --depth, whose preset
 * fills only what no layer sets (effort, among others), and keys of the
 * configuration file (written with --config, a layer above the account's
 * settings, so its ultra: false beats an account's ultra) that hold the
 * review to the depth whatever the account sets. Standard adds nothing.
 */
export function depthRun(depth: ReviewDepth): { config: DepthConfig; flags: string[] } {
  const {
    reviewersOff = [],
    showPreExisting,
    minInlineSeverity,
    maxInlineComments,
    ultra,
  } = REVIEW_DEPTH_SETTINGS[depth];
  return {
    config: {
      ...(reviewersOff.length > 0
        ? {
            reviewers: Object.fromEntries(
              reviewersOff.map((id) => [id, { enabled: false as const }]),
            ),
          }
        : {}),
      ...(showPreExisting !== undefined ? { showPreExisting } : {}),
      ...(minInlineSeverity !== undefined ? { minInlineSeverity } : {}),
      ...(maxInlineComments !== undefined ? { maxInlineComments } : {}),
      ...(ultra === false ? { ultra } : {}),
    },
    flags: [...(depth === "standard" ? [] : ["--depth", depth]), ...(ultra ? ["--ultra"] : [])],
  };
}
