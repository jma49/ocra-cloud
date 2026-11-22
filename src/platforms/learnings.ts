import type { LearningChangeOutcome } from "../shared/index.js";

// A repository's learning files, read and changed as the signed-in user:
// the directory at a commit, the files' bytes with their last commits, the
// open pull requests that propose learnings, and a change committed on a
// new branch (then opened as a pull request) or on the default branch.
// Each answers null when the platform could not be reached. Nothing is kept.

type RepoRef = { platformRepoId: string; fullName: string };
type RepoHead = RepoRef & { branch: string; commit: string };

export type LearningEntry = { path: string; blobId: string };

export type LearningRead = LearningEntry & {
  /** undefined when it could not be read, or is over the contract's size. */
  bytes: Uint8Array | undefined;
  lastCommit: { sha: string; at: string | null } | null;
};

type LearningProposal = {
  number: number;
  title: string;
  url: string;
  branch: string;
  head: string;
  author: string | null;
  createdAt: string;
};

export type LearningChange = {
  path: string;
  /** null deletes the file. */
  content: Uint8Array | null;
  /** The blob the change was made on; null for a file that must not exist yet. */
  expected: string | null;
  message: string;
  /** A new branch from the head's commit, opened as a pull request; null commits to the default branch. */
  pull: { branch: string; title: string; body: string } | null;
};

export type LearningChangeResult = {
  outcome: LearningChangeOutcome;
  pull: { number: number; url: string } | null;
};

export interface RepoLearnings {
  /** The regular files directly under the learnings directory; [] when there is none. */
  list(token: string, repo: RepoRef, commit: string): Promise<LearningEntry[] | null>;
  read(
    token: string,
    repo: RepoRef,
    commit: string,
    paths: string[],
  ): Promise<LearningRead[] | null>;
  /** Open pull requests from this repository's proposal branches into `base`. */
  proposals(
    token: string,
    repo: RepoRef,
    base: string,
  ): Promise<{ proposals: LearningProposal[]; more: boolean } | null>;
  change(
    token: string,
    head: RepoHead,
    change: LearningChange,
  ): Promise<LearningChangeResult | null>;
}

/** The engine's proposal branches (`ocra learn --propose`, ADR-0040) start with it. */
// Deliberate copy of the CLI's PROPOSAL_BRANCH until cloud-contract exports it.
export const PROPOSAL_BRANCH = "ocra/learnings-";

/** Proposals read per request: each costs a few platform calls. */
export const MAX_PROPOSALS = 10;

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
