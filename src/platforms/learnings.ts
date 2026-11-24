// A repository's learnings directory and the open pull requests that propose
// learnings, read as the signed-in user; the files themselves are read and
// changed through RepoFiles. Each answers null when the platform could not
// be reached. Nothing is kept.

type RepoRef = { platformRepoId: string; fullName: string };

export type LearningEntry = { path: string; blobId: string };

type LearningProposal = {
  number: number;
  title: string;
  url: string;
  branch: string;
  head: string;
  author: string | null;
  createdAt: string;
  /** The platform merges it once what the branch requires is met. */
  autoMerge: boolean;
  /** Who it asks to review it. */
  reviewers: string[];
};

export interface RepoLearnings {
  /** The regular files directly under the learnings directory; [] when there is none. */
  list(token: string, repo: RepoRef, commit: string): Promise<LearningEntry[] | null>;
  /** Open pull requests from this repository's proposal branches into `base`. */
  proposals(
    token: string,
    repo: RepoRef,
    base: string,
  ): Promise<{ proposals: LearningProposal[]; more: boolean } | null>;
}

/** Proposals read per request: each costs a few platform calls. */
export const MAX_PROPOSALS = 10;
