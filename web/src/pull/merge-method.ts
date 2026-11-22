import type { CodePlatformKind, MergeMethod } from "../../../src/shared/index.js";

type Labels = Record<MergeMethod, string>;

// GitLab offers "rebase" only on a fast-forward project, where its own button says fast-forward.
const REBASE: Record<CodePlatformKind, { one: string; each: string }> = {
  github: { one: "Rebase and merge", each: "Rebase each" },
  gitlab: { one: "Fast-forward merge", each: "Fast-forward each" },
};

export function methodLabels(platform: CodePlatformKind): Labels {
  return { merge: "Merge commit", squash: "Squash and merge", rebase: REBASE[platform].one };
}

export function stackMethodLabels(platform: CodePlatformKind): Labels {
  return { merge: "Merge commits", squash: "Squash each", rebase: REBASE[platform].each };
}
