import { sha256Hex } from "../crypto.js";
import type { CodePlatformKind } from "../shared/index.js";
import type { PullActions } from "./actions.js";
import type { PullDiffs } from "./changes.js";
import type { RepoContents } from "./contents.js";
import type { PullCycles } from "./cycles.js";
import type { PullListing } from "./pulls.js";
import type { MergeQueue } from "./queue.js";

// What the product layer needs from a code platform, whatever it is: GitHub,
// gitlab.com or a self-hosted GitLab. Each one is reached as the signed-in
// user, with the token its OAuth flow gave, and nothing it answers is
// stored but repository names the account chose to keep.

/** A repository the user reaches on a platform. */
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
  /** A new token pair for a refresh token; null when it was refused. */
  refresh(refreshToken: string): Promise<TokenAnswer | null>;
  /** The repositories the user reaches; null when the platform refused the token. */
  listRepos(accessToken: string): Promise<RepoListing | null>;
  /** null when the platform refused the token. */
  listPulls(accessToken: string): Promise<PullListing | null>;
  readonly contents: RepoContents;
  readonly changes: PullDiffs;
  readonly actions: PullActions;
  readonly queue: MergeQueue;
  readonly cycles: PullCycles;
}

/**
 * The CLI's name for a repository before it salts and hashes it:
 * `https://host/path` without the port, case-folded (the engine's
 * normaliseRemote).
 */
// Deliberate copy of the engine's rule until cloud-contract exports it; the
// vectors in test/platforms.test.ts are the engine's.
export const repoIdentity = (host: string, fullName: string) =>
  `https://${host.replace(/:\d+$/, "")}/${fullName.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")}`.toLowerCase();

/** The hash the CLI uploads for a repository, for this account's salt. */
export const repoHashOf = (salt: string, host: string, fullName: string) =>
  sha256Hex(`${salt}:${repoIdentity(host, fullName)}`);
