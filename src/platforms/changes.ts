// A pull request's changes as the platform reports them: where each file
// changed (hunk ranges, for the impact graph), or the diff itself, for the
// pull request's page. Read as the account for one request; nothing read is kept.

/** One `@@ -oldStart,oldLines +newStart,newLines @@` header. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number };

export type ChangedFile = {
  path: string;
  /** The path on the base side: the same as `path` unless the file was renamed. */
  oldPath: string;
  status: "added" | "removed" | "modified" | "renamed";
  /** null when the platform sent no diff for it (binary, or too large). */
  hunks: Hunk[] | null;
};

export type PullChanges = {
  /** What the platform says the pull request is: null where it did not say. */
  title: string | null;
  author: string | null;
  /** Its page on the platform. */
  url: string | null;
  base: string;
  head: string;
  /** The platform's updated_at of the pull request, where it said. */
  updatedAt: string | null;
  files: ChangedFile[];
  /** True when the pull request has more files than were read. */
  truncated: boolean;
};

/** A changed file with its diff, as the platform listed it. */
export type PatchedFile = Omit<ChangedFile, "hunks"> & {
  additions: number;
  deletions: number;
  /** null when the platform sent no diff for it, or the page's diff budget ran out. */
  patch: string | null;
  /**
   * What changes when the file changes at a later head: GitHub's blob sha,
   * a hash of GitLab's diff (gitlab-changes.ts); null when GitHub sent none.
   */
  version: string | null;
};

export type PullPatches = Omit<PullChanges, "files"> & { files: PatchedFile[] };

// Both answer null when the account does not reach the pull request, or the platform failed.
export interface PullDiffs {
  /** At most maxFiles of them (MAX_CHANGED_FILES by default), read in pages. */
  changes(
    token: string,
    fullName: string,
    number: number,
    maxFiles?: number,
  ): Promise<PullChanges | null>;
  patches(token: string, fullName: string, number: number): Promise<PullPatches | null>;
}

/** The diff text one page answers with, all files together. */
const MAX_PATCH_BYTES = 4_000_000;

/** Files read per pull request: GitHub lists at most 3,000. */
export const MAX_CHANGED_FILES = 3000;

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

/** The hunk headers of a unified diff, in order. */
export function hunksOf(patch: string): Hunk[] {
  return [...patch.matchAll(HEADER)].map((m) => ({
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

/** The lines a unified diff adds and removes. */
export function lineCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * The listed files with their diffs while they fit MAX_PATCH_BYTES; past it
 * a file keeps its counts but not its diff, and the answer says it is truncated.
 */
export function withinBudget(listed: PullPatches, max = MAX_PATCH_BYTES): PullPatches {
  let left = max;
  let cut = false;
  const files = listed.files.map((f) => {
    if (f.patch === null) return f;
    if (f.patch.length > left) {
      cut = true;
      left = 0;
      return { ...f, patch: null };
    }
    left -= f.patch.length;
    return f;
  });
  return { ...listed, files, truncated: listed.truncated || cut };
}
