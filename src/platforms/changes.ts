// A pull request's changes as the platform reports them, reduced to where
// each file changed: hunk ranges, never the changed lines. Read as the
// account for one request; nothing read is kept.

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
  base: string;
  head: string;
  files: ChangedFile[];
  /** True when the pull request has more files than were read. */
  truncated: boolean;
};

export interface PullDiffs {
  /** null when the account does not reach the pull request, or the platform failed. */
  changes(token: string, fullName: string, number: number): Promise<PullChanges | null>;
}

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
