// A repository's files at a commit, read through the platform's API as the
// account, for builds that run without a checkout. Nothing read is kept.

/** A repository as the platform names it: its own id, and its path. */
type RepoRef = { platformRepoId: string; fullName: string };

/** A repository the account reaches, with its default branch's newest commit. */
type RepoHead = RepoRef & { branch: string; commit: string };

export type TreeEntry = { path: string; blobId: string; size?: number };

export type RepoTree = {
  entries: TreeEntry[];
  /** True when the platform listed fewer files than the commit has. */
  truncated: boolean;
};

export interface RepoContents {
  /** null when the account does not reach it, or it has no default branch. */
  head(token: string, fullName: string): Promise<RepoHead | null>;
  /** The commit's regular files; null when the platform refused or failed. */
  tree(
    token: string,
    repo: RepoRef,
    commit: string,
    signal?: AbortSignal,
  ): Promise<RepoTree | null>;
  /** undefined when it could not be read, or is over maxBytes. */
  blob(
    token: string,
    repo: RepoRef,
    blobId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined>;
}

/** A full commit id, SHA-1 or SHA-256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
