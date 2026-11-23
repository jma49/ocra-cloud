import type { GraphBuildState } from "./domain.js";

// What a pull request's change reaches, from the server's code graph: the
// symbols its diff changes on the base side and their uses in the rest of
// the repository, matched by name. GET /api/graphs/impact answers it.

/** A use of a changed symbol in a file the pull request does not change. */
export type ImpactUse = {
  path: string;
  line: number;
  /** The innermost definition the use sits in. */
  within: string | null;
  /** The line's text at the graph's commit; null past the request's cap or when unreadable. */
  code: string | null;
};

export type ImpactSymbol = {
  name: string;
  kind: string;
  /** Where it is defined on the base side. */
  path: string;
  startLine: number;
  endLine: number;
  /** signature: a hunk touches its first line, or the file is deleted. */
  change: "signature" | "body";
  /** Head-side line ranges of the hunks that changed it, inclusive: where its findings sit. */
  lines: [number, number][];
  uses: ImpactUse[];
  /** All its uses, when `uses` lists fewer. */
  useCount: number;
  fileCount: number;
};

export type ImpactView = {
  /** null where a runner works the impact out when it reviews, and none has yet. */
  pull: {
    base: string;
    head: string;
    files: number;
    /** The platform listed fewer files than the pull request changes. */
    truncated: boolean;
    /** Changed files the platform sent no diff for. */
    unread: number;
  } | null;
  /** The graph the answer comes from: the newest finished build. */
  graph: {
    commit: string;
    /** It is of the pull request's base. */
    current: boolean;
    truncated: boolean;
    files: number | null;
  } | null;
  /** The repository's newest build when it is not that graph's: queued, running, failed. */
  build: { state: GraphBuildState; commit: string; error: string | null } | null;
  symbols: ImpactSymbol[];
  /** Changed symbols past the cap, not listed. */
  more: number;
};
