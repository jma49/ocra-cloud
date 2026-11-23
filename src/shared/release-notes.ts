import type { CodePlatformKind } from "./domain.js";

// "Draft release notes" for a repository: the pull requests merged between
// two refs, grouped by the Conventional Commit type of their titles,
// without a model; the user's edit is then saved as a draft release on the
// platform as them, or, on GitLab, which keeps no draft releases, held by
// ocra Cloud until they publish it.

/** At most this many pull requests in one draft; `truncated` says when the range held more. */
export const MAX_RELEASE_PULLS = 200;
/** As long as GitHub takes a release's body. */
export const MAX_RELEASE_BODY_CHARS = 125_000;
export const MAX_RELEASE_NAME_CHARS = 255;

/** In the order the draft lists them; `hidden` is left out of the body unless asked for. */
export const RELEASE_SECTIONS = [
  "breaking",
  "added",
  "fixed",
  "performance",
  "other",
  "hidden",
] as const;
export type ReleaseSection = (typeof RELEASE_SECTIONS)[number];

export type ReleasePullView = {
  number: number;
  title: string;
  url: string;
  /** The author's login on the platform; null when it gave none (a deleted user). */
  author: string | null;
  mergedAt: string | null;
  /** The title's Conventional Commit type, lowercased; null for a title that is not one. */
  type: string | null;
  breaking: boolean;
  section: ReleaseSection;
  /** The newest of the account's own reviews of it; null when it has none. */
  review: { verdict: ReleaseReviewVerdict | null; findings: number } | null;
};

export type ReleaseReviewVerdict =
  | "approved"
  | "approved_with_comments"
  | "minor_issues"
  | "significant_concerns";

export type ReleaseNotesView = {
  platform: CodePlatformKind;
  repo: string;
  from: string;
  to: string;
  /** Every pull request merged in the range, hidden ones included, by number. */
  pulls: ReleasePullView[];
  /** True when the range held more commits or pull requests than one draft reads. */
  truncated: boolean;
  /** The draft in Markdown, every @ broken so it mentions no one. */
  body: string;
  /** Whether a publish can save it as a draft: on GitHub a draft release, on GitLab a held draft. */
  drafts: boolean;
  /** GitLab only: the account's held drafts of this repository, newest edit first. */
  held?: HeldReleaseDraftView[];
};

export type ReleasePublishRequest = {
  platform: CodePlatformKind;
  repo: string;
  tag: string;
  /** The branch or commit the tag is made at when the release is published. */
  target: string;
  name: string;
  body: string;
  draft: true;
  /**
   * GitLab only: the version of the held draft of this tag that this save
   * edits; left out to start one. A save from an older version is `stale`.
   */
  version?: number | undefined;
};

type ReleaseDraftView = { id: number; url: string };

/**
 * A GitLab release's notes that ocra Cloud holds for the account until it
 * publishes them: GitLab has no draft releases, and a release there makes
 * its tag at once. One per repository and tag; `version` counts its saves.
 */
export type HeldReleaseDraftView = {
  id: string;
  tag: string;
  target: string;
  name: string;
  body: string;
  version: number;
  updatedAt: string;
};

/**
 * `created` or `updated` (the draft release of that tag, edited); `held` on
 * GitLab, the draft as ocra Cloud now holds it; `tag_exists` when the tag,
 * or a published release of it, already exists; `target_missing` when the
 * target is no branch or commit of the repository; `refused` when the
 * platform refused (no permission); `unsupported` where the platform keeps
 * no draft releases.
 */
export type ReleasePublishAnswer =
  | { outcome: "created" | "updated"; release: ReleaseDraftView }
  | { outcome: "held"; draft: HeldReleaseDraftView }
  | { outcome: "tag_exists" | "target_missing" | "refused" | "unsupported" };

/** Publishing a held draft: a release on GitLab, made with its tag at the target. */
export type HeldReleasePublishRequest = { version: number };

/** `published` with the release's page, the held draft then dropped; else as a save answers. */
export type HeldReleasePublishAnswer =
  | { outcome: "published"; url: string }
  | { outcome: "tag_exists" | "target_missing" | "refused" };
