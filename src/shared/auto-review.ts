import type { GenerateKind, MendLevel } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";
import type { ReviewDepth } from "./review-depths.js";

// Pull requests reviewed by the server itself when they open or gain
// commits (ADR-0046): the repositories an account enrolled and their jobs.

export const REVIEW_JOB_STATES = ["queued", "running", "done", "failed", "superseded"] as const;
type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

/**
 * What a repository does with the findings people decline in their threads:
 * nothing, a pull request of learnings left for a person to merge, or one
 * that merges once its checks pass.
 */
export const LEARN_MODES = ["off", "propose", "merge"] as const;
export type LearnMode = (typeof LEARN_MODES)[number];
/** As the engine's `ocra learn --propose` does unless told to leave it to a person. */
export const DEFAULT_LEARN_MODE: LearnMode = "merge";

/**
 * What a comment that is an `@ocra` command asks of a pull request
 * (src/auto-review/commands.ts); any other mention is a question.
 */
export const COMMENT_COMMANDS = [
  "review",
  "pause",
  "resume",
  "resolve",
  "generate_tests",
  "generate_docstrings",
  "help",
] as const;
export type CommentCommand = (typeof COMMENT_COMMANDS)[number];
/** How a command ended: `refused` when its author may not push to the repository. */
export const COMMENT_COMMAND_OUTCOMES = ["pending", "done", "refused", "failed"] as const;
export type CommentCommandOutcome = (typeof COMMENT_COMMAND_OUTCOMES)[number];

/** An `@ocra` command on a pull request as the console lists it: never its comment or who wrote it. */
export type PullCommandView = {
  command: CommentCommand;
  outcome: CommentCommandOutcome;
  createdAt: string;
  finishedAt: string | null;
};

/** The most a pull request's command listing holds, newest first. */
export const MAX_PULL_COMMANDS = 20;

/** Whether the pull request's automatic reviews are paused, and its newest commands. */
export type PullCommandsView = { paused: boolean; commands: PullCommandView[] };

/** What PUT and DELETE of a pull request's pause answer. */
export type PullPauseView = { paused: boolean };

/**
 * Why auto review of an enrolled repository is paused (src/auto-review/lifecycle.ts):
 * removed from the GitHub App's installation, deleted, its installation
 * suspended or uninstalled. A paused repository runs no jobs and keeps its history.
 */
export const REPO_PAUSES = ["removed", "deleted", "suspended", "uninstalled"] as const;
export type RepoPause = (typeof REPO_PAUSES)[number];

/** The error of a queued job given up when its repository was paused. */
export const REPO_PAUSED_ERROR = "repository_paused";

/** A queued job's error while it waits for the account's daily gateway calls to reset. */
export const DAILY_LIMIT_WAIT = "daily_limit";
/**
 * A done job's note that the repository's .ocra/config.json could not be
 * read or is not valid, so its review ran without it, or that it loosened
 * an inline comment limit or ultra, so its review ran without that value.
 */
export const REPO_CONFIG_IGNORED = "repo_config_ignored";

export type AutoReviewRepoView = {
  id: string;
  platform: CodePlatformKind;
  host: string;
  fullName: string;
  depth: ReviewDepth;
  /** Whether pull requests are reviewed as they open or gain commits; off, only when a person asks. */
  automatic: boolean;
  learn: LearnMode;
  /** Whether the bot rebases and force-pushes the pull requests stacked on one that merged. */
  restack: boolean;
  /** How far a fix asked of ocra goes: proposed for a person to commit, or committed by the bot. */
  mend: MendLevel;
  /** Whether a failed check on a pull request starts a round that fixes it, unasked; only at `commit`. */
  mendChecks: boolean;
  /** Whether the account gave the GitLab project its own access token, never the token itself. */
  hasAccessToken: boolean;
  /** The username of that token's bot user; null without one. */
  accessTokenBot: string | null;
  /** Whether ocra added the GitLab project's webhook itself, and removes it on unenroll. */
  webhookManaged: boolean;
  /** Why its jobs are paused; null while it runs. Enrolling it again lifts the pause. */
  paused: RepoPause | null;
  latest: {
    number: number;
    head: string;
    state: ReviewJobState;
    error: string | null;
    finishedAt: string | null;
  } | null;
};

/** What setting or clearing an enrolled GitLab project's access token answers. */
export type RepoAccessTokenView = { hasAccessToken: boolean; accessTokenBot: string | null };

/**
 * Where a repository's webhook delivers: GitHub's is the App's. A GitLab
 * project's has its own secret, shown once, and `managed` says whether ocra
 * added the hook itself; `problem` says why it could not, when it tried, and
 * the hook is then added by hand with that address and secret.
 */
export type AutoReviewWebhookView = {
  url: string;
  secret?: string;
  managed?: boolean;
  problem?: string;
};

/** A new secret for adding a GitLab project's webhook by hand, answered once. */
export type AutoReviewWebhookSecretView = { url: string; secret: string; events: string[] };

/** What enrolling a repository answers. */
export type AutoReviewEnrolledView = { repo: AutoReviewRepoView; webhook: AutoReviewWebhookView };

/**
 * Repositories one bulk enrollment names at most: each is read as the user,
 * twice, within the calls one request may make.
 */
export const MAX_BULK_ENROLL = 20;

/**
 * GitLab projects one bulk enrollment names at most: each is read twice and
 * gets its hook, two calls more.
 */
export const MAX_BULK_ENROLL_GITLAB = 10;

/**
 * Why a repository of a bulk enrollment was not enrolled: the user does not
 * reach it through the App, another account enrolls it, or this account has
 * as many as it may.
 */
export type EnrollRefusal = "not_found" | "taken" | "limit";

/** One repository of a bulk enrollment: enrolled now, enrolled before, or refused. */
export type BulkEnrollResult =
  | {
      fullName: string;
      outcome: "enrolled" | "already";
      repo: AutoReviewRepoView;
      /** A GitLab project enrolled now: its hook as ocra added it, or the problem to add it by hand. */
      webhook?: AutoReviewWebhookView;
    }
  | { fullName: string; outcome: "refused"; reason: EnrollRefusal };

export type BulkEnrollView = { results: BulkEnrollResult[] };

/** A GitHub App installation the user reaches, and whether this account enrolls the repositories added to it. */
export type AutoEnrollInstallationView = {
  id: string;
  /** The user or organisation it is installed on. */
  owner: string;
  enabled: boolean;
  /** Whether the repositories it enrolls are reviewed as their pull requests open; off, only when a person asks. */
  automatic: boolean;
};

/** The user's installations; `more` when GitHub listed more than were read. */
export type AutoEnrollInstallationsView = {
  installations: AutoEnrollInstallationView[];
  more: boolean;
};

/** A GitLab group the user maintains, and whether this account enrolls its new projects. */
export type AutoEnrollGroupView = {
  id: string;
  /** The group's path, its parents' included. */
  fullPath: string;
  enabled: boolean;
  /** Whether the projects it enrolls are reviewed as their merge requests open; off, only when a person asks. */
  automatic: boolean;
};

/** The user's GitLab groups; `more` when GitLab listed more than were read. */
export type AutoEnrollGroupsView = { groups: AutoEnrollGroupView[]; more: boolean };

/** What the automatic switch of an enrolled repository answers. */
export type AutoReviewSwitchView = { automatic: boolean };

/** What the learn setting of an enrolled repository answers. */
export type AutoReviewLearnView = { learn: LearnMode };

/** A pull request whose declined findings are being drafted into learnings, or were. */
export type LearnJobView = {
  number: number;
  state: ReviewJobState;
  error: string | null;
  /** When it last ended; null while it has not. */
  finishedAt: string | null;
};

export type { GenerateKind };

/** One request to generate, on the head it was asked for. */
export type GenerateJobView = {
  kind: GenerateKind;
  head: string;
  state: ReviewJobState;
  error: string | null;
  finishedAt: string | null;
};

/** A pull request's review asked for on the console, or the newest one the server ran. */
export type PullReviewJobView = {
  state: Exclude<ReviewJobState, "superseded">;
  jobId: string;
  head: string;
  queuedAt: string;
  /** The depth chosen for this review; null when it takes the repository's. */
  depth: ReviewDepth | null;
};

export type PullReviewNowView = {
  job: PullReviewJobView | null;
  /** The repository's depth, which a review takes unless one is chosen for it. */
  depth: ReviewDepth;
  /** The pull request's review while it runs and is relayed (ADR-0056), to watch. */
  live: { id: string } | null;
};

/**
 * The remote runners that asked this deployment for jobs lately, newest
 * first; `remote` is false where the server runs them itself.
 */
export type ReviewRunnersView = {
  remote: boolean;
  runners: { name: string; version: string; lastSeenAt: string }[];
};

/** The top-level keys of .ocra/config.json a hosted review applies; of `github`, only `requestChanges`. */
export const HOSTED_CONFIG_KEYS = [
  "include",
  "exclude",
  "reviewers",
  "verify",
  "judge",
  "showPreExisting",
  "maxTasks",
  "maxCostUsd",
  "minInlineSeverity",
  "maxInlineComments",
  "ultra",
  "github",
] as const;
/** The keys of a `reviewers` entry a hosted review applies. */
export const HOSTED_REVIEWER_KEYS = ["enabled", "minTier"] as const;
