import { normaliseRemote } from "@open-cr-agent/cloud-contract";
import { sha256Hex } from "../crypto.js";
import type { CodePlatformKind } from "../shared/index.js";
import type { RepoAccess } from "./access.js";
import type { PullActions } from "./actions.js";
import type { PullAutoMerge } from "./auto-merge.js";
import type { PullDiffs } from "./changes.js";
import type { RepoContents } from "./contents.js";
import type { PullCycles } from "./cycles.js";
import type { PullEdits } from "./edits.js";
import type { RepoFiles } from "./files.js";
import type { RepoIssues } from "./issues.js";
import type { RepoLearnings } from "./learnings.js";
import type { PullMergeStatus } from "./merge-status.js";
import type { ListedPull, PullListing, PullSearch, TeamAsk } from "./pulls.js";
import type { MergeQueue } from "./queue.js";
import type { PullReadiness } from "./readiness.js";
import type { RepoReconcile } from "./reconcile.js";
import type { RepoReleases } from "./releases.js";
import type { PullReviewers } from "./reviewers.js";
import type { PullRoster } from "./roster.js";
import type { PullSince } from "./since.js";
import type { PullStacks } from "./stacks.js";
import type { PullThreads } from "./threads.js";
import type { PullFileViewed } from "./viewed.js";

// What the product layer needs from a code platform, whatever it is: GitHub,
// gitlab.com or a self-hosted GitLab. Each one is reached as the signed-in
// user, with the token its OAuth flow gave, and nothing it answers is
// stored but repository names the account chose to keep.

/** A repository the user reaches on a platform. */
/** An installation of the platform's app: its id, and the user or organisation it is on. */
export type InstallationListing = { installations: { id: string; owner: string }[]; more: boolean };

export type PlatformRepo = {
  /** The platform's own id, as text. */
  id: string;
  /** Its path as the platform writes it: `owner/repo`, or `group/subgroup/repo`. */
  fullName: string;
  url: string;
  private: boolean;
};

type RepoListing = {
  repositories: PlatformRepo[];
  /** True when more were reachable than one request may read. */
  more: boolean;
};

/** The platform's user a token is of: its id, and its login when the platform gave a usable one. */
export type LinkedUser = { id: string; login: string | null };

/** What a code exchange or refresh answers, in OAuth 2's words. */
export type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
};

export interface CodePlatform {
  readonly kind: CodePlatformKind;
  /** The host its repositories live on, as the CLI writes it: `github.com`. */
  readonly host: string;
  /** Its web address, with the relative root of an instance installed under a path. */
  readonly url: string;
  /**
   * Where the user chooses the repositories the platform's app reaches;
   * absent where connecting already reaches every repository the user can.
   */
  readonly install?: string;
  /** A new token pair for a refresh token; null when it was refused. */
  refresh(refreshToken: string): Promise<TokenAnswer | null>;
  /** The repositories the user reaches; null when the platform refused the token. */
  listRepos(accessToken: string): Promise<RepoListing | null>;
  /** The app's installations the user reaches, where the platform has them; null when refused. */
  installations?(accessToken: string): Promise<InstallationListing | null>;
  /**
   * null when the platform refused the token. `teamAsks` are listed too
   * where the platform's own lists of the user's reviews miss them.
   */
  listPulls(accessToken: string, teamAsks: readonly TeamAsk[]): Promise<PullListing | null>;
  /**
   * The pull requests the user is involved in that match, at most `limit`;
   * null when the platform failed or refused the token.
   */
  searchPulls(accessToken: string, search: PullSearch, limit: number): Promise<ListedPull[] | null>;
  readonly contents: RepoContents;
  readonly changes: PullDiffs;
  readonly since: PullSince;
  readonly actions: PullActions;
  /** Read as the bot: who may give ocra a command on the repository. */
  readonly access: RepoAccess;
  readonly queue: MergeQueue;
  readonly autoMerge: PullAutoMerge;
  readonly cycles: PullCycles;
  readonly stacks: PullStacks;
  readonly learnings: RepoLearnings;
  readonly files: RepoFiles;
  readonly mergeStatus: PullMergeStatus;
  readonly readiness: PullReadiness;
  readonly reviewers: PullReviewers;
  readonly roster: PullRoster;
  readonly threads: PullThreads;
  readonly edits: PullEdits;
  readonly issues: RepoIssues;
  readonly releases: RepoReleases;
  readonly reconcile: RepoReconcile;
  /** null where the platform keeps no viewed files: the console keeps them (pull_file_views). */
  readonly viewed: PullFileViewed | null;
}

/**
 * The CLI's name for a clone of the platform's repository before it salts
 * and hashes it: the contract's normaliseRemote of the clone's URL, under
 * the instance's relative root.
 */
export function repoIdentity(platform: Pick<CodePlatform, "url">, fullName: string): string {
  const identity = normaliseRemote(`${platform.url}/${fullName}`);
  if (!identity) throw new Error("not a repository address");
  return identity;
}

/** The hash the CLI uploads for a platform's repository, for this account's salt. */
export const repoHashOf = (salt: string, platform: Pick<CodePlatform, "url">, fullName: string) =>
  sha256Hex(`${salt}:${repoIdentity(platform, fullName)}`);
