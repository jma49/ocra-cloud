import type { CodePlatformKind } from "./domain.js";
import type { PullFileView } from "./pull-page.js";

// A pull request's versions: each head it was pushed to, numbered from 1,
// and the diff between any two of them.

/**
 * How a version came after the one listed before it: `first` for the
 * first when nothing came before it, `fast_forward` when it added to it,
 * `rewrite` when a force push or rebase replaced its history.
 */
export type PullVersionKind = "first" | "fast_forward" | "rewrite";

export type PullVersion = {
  /** 1 for the oldest head listed, counting up by push. */
  version: number;
  head: string;
  /** When it was pushed; null when only its commit's time is known (it orders the list then). */
  pushedAt: string | null;
  /** null when neither the platform nor ocra's webhooks say. */
  kind: PullVersionKind | null;
};

/** GET /api/pulls/versions: oldest first, the current head last but where it was pushed before. */
export type PullVersionsView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  versions: PullVersion[];
  /**
   * true when the list starts at the pull request's opening: GitLab listed
   * every version, or ocra's webhooks kept its first push. false when
   * earlier versions may be missing.
   */
  complete: boolean;
};

/**
 * How two versions were compared: `history` along it, the commits from an
 * ancestor; `trees` the two trees straight, when one is no ancestor of the
 * other (a force push or rebase between them).
 */
type PullVersionCompare = "history" | "trees";

/**
 * What one compare came to: `same` when both are one head, `changes` with
 * the diff, `unavailable` when the platform could not compare them.
 */
type PullVersionCompareState = "same" | "changes" | "unavailable";

/** GET /api/pulls/versions/compare: the files changed from `from` to `to`. */
export type PullVersionCompareView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  from: string;
  to: string;
  state: PullVersionCompareState;
  /** null when nothing was compared. */
  compare: PullVersionCompare | null;
  /**
   * false when the files carry no lines: GitHub compares trees by blob, so
   * each file says only that it was added, removed or modified (0 and 0
   * lines, no patch).
   */
  lines: boolean;
  /** `viewed` is always null. */
  files: PullFileView[];
  truncated: boolean;
};
