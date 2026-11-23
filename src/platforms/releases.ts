import type { ReleasePublishAnswer } from "../shared/index.js";

// The pull requests merged between two refs of a repository, and a draft
// release saved as the signed-in user: the platform decides what they may
// read and write, and nothing is kept.

/** What one compare may answer: its commits and, on GitHub, up to 300 files' patches. */
export const MAX_COMPARE_BYTES = 16 * 1024 * 1024;
/** The commits of a range one draft reads: one page of GitHub's compare. */
export const MAX_RANGE_COMMITS = 250;

export type RangePull = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  mergedAt: string | null;
  /** Its description has a `BREAKING CHANGE:` footer. */
  breakingNote: boolean;
};

type RangePulls = {
  pulls: RangePull[];
  truncated: boolean;
  /** The range's compare page on the platform. */
  compareUrl: string;
};

type ReleaseDraft = { tag: string; target: string; name: string; body: string };

export interface RepoReleases {
  /** False where the platform keeps no draft releases, so `saveDraft` answers `unsupported` unsent. */
  readonly drafts: boolean;
  /** `missing` when a ref is not of the repository; null when the platform was not reached. */
  mergedBetween(
    token: string,
    fullName: string,
    from: string,
    to: string,
    max: number,
  ): Promise<RangePulls | "missing" | null>;
  /** null when the platform was not reached. */
  saveDraft(
    token: string,
    fullName: string,
    draft: ReleaseDraft,
  ): Promise<ReleasePublishAnswer | null>;
}

/** A Conventional Commit footer that breaks compatibility, in a pull request's description. */
export const saysBreaking = (description: string | null | undefined) =>
  typeof description === "string" && /^BREAKING[ -]CHANGE:/m.test(description);

/** A ref as a path in an address: each part encoded, the slashes kept. */
export const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const isSha = (s: unknown): s is string => typeof s === "string" && SHA.test(s);

export const isUnder = (url: unknown, origin: string): url is string =>
  typeof url === "string" && url.startsWith(`${origin}/`);
