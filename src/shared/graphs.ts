import type { CodePlatformKind, GraphBuildState } from "./domain.js";

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
