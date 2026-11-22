import type { FileChangeOutcome } from "../shared/index.js";

// Named files of a repository, read and changed as the signed-in user: their
// bytes at a commit with their last commits, and a change committed on a new
// branch (then opened as a pull request) or on the default branch, guarded by
// the blob it was made on. Learnings and the review configuration go through
// it. Each answers null when the platform could not be reached. Nothing is kept.

type RepoRef = { platformRepoId: string; fullName: string };
type RepoHead = RepoRef & { branch: string; commit: string };

export type FileRead = {
  path: string;
  /** null when the commit has no such file; "" when it could not be read. */
  blobId: string | null;
  /** undefined when it is missing, could not be read, or is over the size asked for. */
  bytes: Uint8Array | undefined;
  lastCommit: { sha: string; at: string | null } | null;
};

export type FileChange = {
  path: string;
  /** null deletes the file. */
  content: Uint8Array | null;
  /** The blob the change was made on; null for a file that must not exist yet. */
  expected: string | null;
  message: string;
  /** A new branch from the head's commit, opened as a pull request; null commits to the default branch. */
  pull: { branch: string; title: string; body: string } | null;
};

export type FileChangeResult = {
  outcome: FileChangeOutcome;
  pull: { number: number; url: string } | null;
};

export interface RepoFiles {
  read(
    token: string,
    repo: RepoRef,
    commit: string,
    paths: string[],
    maxBytes: number,
  ): Promise<FileRead[] | null>;
  commit(token: string, head: RepoHead, change: FileChange): Promise<FileChangeResult | null>;
}

/** Where a pre-read of the file stands against what the change expects. */
export function guardOf(
  found: { blobId: string } | "missing",
  expected: string | null,
): "ok" | "conflict" {
  if (found === "missing") return expected === null ? "ok" : "conflict";
  return found.blobId === expected ? "ok" : "conflict";
}

/** Runs `task` on each item, at most `limit` at a time, keeping order. */
export async function inBatches<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(task))));
  }
  return out;
}

export const refused: FileChangeResult = { outcome: "refused", pull: null };
export const conflict: FileChangeResult = { outcome: "conflict", pull: null };

/** A proposal branch: `prefix`, then the time and a random tail, unique to this change. */
export function proposalBranch(prefix: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const tail = [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${stamp}-${tail}`;
}
