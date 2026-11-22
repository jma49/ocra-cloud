import type { CodePlatformKind, GraphBuildState } from "./domain.js";

/**
 * What a deployment does with code graphs (CODE_GRAPH): keep them for the
 * repositories an account adds, keep them only where the owner agreed when
 * adding one, or build none.
 */
export const GRAPH_POLICIES = ["keep", "opt-in", "off"] as const;
export type GraphPolicy = (typeof GRAPH_POLICIES)[number];

/** A repository the server keeps a code graph of, with its newest build. */
export type GraphRepoView = {
  id: string;
  platform: CodePlatformKind;
  host: string;
  fullName: string;
  branch: string;
  latest: {
    commit: string;
    state: GraphBuildState;
    files: number | null;
    bytes: number | null;
    truncated: boolean;
    error: string | null;
    finishedAt: string | null;
  } | null;
};
