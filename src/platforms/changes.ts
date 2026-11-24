// A pull request's changes as the platform reports them: where each file
// changed (hunk ranges, for the impact graph), or the diff itself, for the
// pull request's page. Read as the account for one request; nothing read is kept.

import type { PullState } from "../shared/index.js";

/** One run of changed lines, as an `@@ -oldStart,oldLines +newStart,newLines @@` header without context. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number };

export type ChangedFile = {
  path: string;
  /** The path on the base side: the same as `path` unless the file was renamed. */
  oldPath: string;
  status: "added" | "removed" | "modified" | "renamed";
  /** null when the platform sent no diff for it (binary, or too large). */
  hunks: Hunk[] | null;
};

type PullBranches = { head: string; base: string };

/** The one host of pictures the console's Content-Security-Policy allows (`web/public/_headers`). */
const AVATAR_HOST = "avatars.githubusercontent.com";

/** A picture's address when the console may load it, null otherwise. */
export function avatarOf(url: string | null | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const at = new URL(url);
  return at.protocol === "https:" && at.host === AVATAR_HOST ? at.href : null;
}

export const branchesOf = (head: string | undefined, base: string | undefined) =>
  head && base ? { head, base } : null;

export type PullChanges = {
  /** What the platform says the pull request is: null where it did not say. */
  title: string | null;
  author: string | null;
  /** Its page on the platform. */
  url: string | null;
  state: PullState | null;
  base: string;
  head: string;
  /** The platform's updated_at of the pull request, where it said. */
  updatedAt: string | null;
  /** The branch it merges and the one it merges into, where the platform named both. */
  branches: PullBranches | null;
  /** The author's picture, only from a host the console's content policy lets it load. */
  authorAvatar: string | null;
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

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The runs of changed lines of a unified diff, in order, each as the header
 * git would write for it without context: a hunk's own header also counts the
 * unchanged lines around its changes, which belong to symbols it leaves alone.
 * As in git, a run that only adds names the old line it follows, and one that
 * only removes the new line it follows.
 */
export function hunksOf(patch: string): Hunk[] {
  const runs: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let run: Hunk | undefined;
  const close = () => {
    if (!run) return;
    if (run.oldLines === 0) run.oldStart--;
    if (run.newLines === 0) run.newStart--;
    runs.push(run);
    run = undefined;
  };
  for (const line of patch.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      close();
      // A side with no lines names the line before its place.
      oldLine = Number(header[1]) + (header[2] === "0" ? 1 : 0);
      newLine = Number(header[3]) + (header[4] === "0" ? 1 : 0);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      // Before the first hunk, or "\ No newline at end of file": no line of either side.
    } else if (line.startsWith("-")) {
      run ??= { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
      run.oldLines++;
      oldLine++;
    } else if (line.startsWith("+")) {
      run ??= { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
      run.newLines++;
      newLine++;
    } else {
      close();
      oldLine++;
      newLine++;
    }
  }
  close();
  return runs;
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
export function withinBudget<T extends Pick<PullPatches, "files" | "truncated">>(
  listed: T,
  max = MAX_PATCH_BYTES,
): T {
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
