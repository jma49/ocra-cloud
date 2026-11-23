import { REVIEW_DEPTH_SETTINGS, type ReviewDepth } from "../shared/index.js";

/**
 * What a hosted review's depth adds: keys of its configuration file
 * (written with --config, a layer above the account's settings, which only
 * fill what it leaves out) and CLI flags. Standard adds nothing.
 */
export function depthRun(depth: ReviewDepth): {
  config: { reviewers?: Record<string, { enabled: false }>; showPreExisting?: boolean };
  flags: string[];
} {
  const settings = REVIEW_DEPTH_SETTINGS[depth];
  const off = settings.reviewersOff ?? [];
  return {
    config: {
      ...(off.length > 0
        ? { reviewers: Object.fromEntries(off.map((id) => [id, { enabled: false as const }])) }
        : {}),
      ...(settings.showPreExisting !== undefined
        ? { showPreExisting: settings.showPreExisting }
        : {}),
    },
    flags: settings.ultra ? ["--ultra"] : [],
  };
}
