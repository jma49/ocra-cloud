import type { Verdict } from "./domain.js";

// Rules an account sets for its pull requests: conditions, all of which
// must hold, and the actions taken when they do. A rule runs when a pull
// request of an enrolled repository is queued for review, or when a pull
// request's review is uploaded.

export const AUTOMATION_TRIGGERS = ["queued", "reviewed"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export type AutomationConditions = {
  /** Enrolled repositories (their ids); any of them. */
  repoIds?: string[] | undefined;
  /** The pull request's author's login, any of them; queued only. */
  authors?: string[] | undefined;
  /** The branch it merges into, any of them; queued only. */
  baseBranches?: string[] | undefined;
  /** A pattern for its title, case-insensitive: `*` any text, `?` one character; queued only. */
  title?: string | undefined;
  /** Any of these labels on it; queued only. */
  labels?: string[] | undefined;
  /** Whether the review found something critical; reviewed only. */
  critical?: boolean | undefined;
  /** The review's verdict, any of them; reviewed only. */
  verdicts?: Verdict[] | undefined;
  /** The files it changes, read from the platform when the rule is tried. */
  paths?: AutomationPaths | undefined;
};

/**
 * Globs read as .gitignore reads them: `*` and `?` within a name, `**` any
 * depth, one without a slash at any depth, one naming a directory what is
 * under it, a leading `/` anchors it; case is ignored. A changed file is
 * selected when it matches an include glob (any file without one) and no
 * exclude glob.
 */
export type AutomationPaths = {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  /** True: every changed file must be selected; else at least one. */
  every?: boolean | undefined;
};

/** Files of a pull request read to try its rules' paths; past them a rule may not be decided. */
export const MAX_AUTOMATION_PATHS = 300;

/**
 * Why a rule was not tried: `paths_unavailable` when the changed files
 * could not be read (or a dry run listed none), `too_many_files` when the
 * files read did not decide it.
 */
export const AUTOMATION_SKIP_REASONS = ["paths_unavailable", "too_many_files"] as const;
export type AutomationSkipReason = (typeof AUTOMATION_SKIP_REASONS)[number];

export type AutomationActionKind = AutomationAction["kind"];

export type AutomationAction =
  | { kind: "add_labels"; labels: string[] }
  | { kind: "request_reviewers"; reviewers: string[] }
  /** Plain text, posted as the ocra bot. */
  | { kind: "comment"; body: string }
  /** One of the account's notification channels. */
  | { kind: "notify"; channelId: string }
  /** Queued only: the pull request's head is not reviewed. */
  | { kind: "skip_review" }
  /** Queued only: asks reviewers chosen when it opens or leaves draft, once per pull request. */
  | AssignReviewers;

/**
 * How reviewers are chosen: `suggested` the best of those the console
 * suggests (code owners, recent and same-directory reviewers, fewer open
 * requests), `round_robin` the configured logins in turn, `least_loaded`
 * those of them with the fewest open review requests.
 */
export const ASSIGN_STRATEGIES = ["suggested", "round_robin", "least_loaded"] as const;
export type AssignStrategy = (typeof ASSIGN_STRATEGIES)[number];
export const MAX_ASSIGN_COUNT = 5;
/** Logins a round_robin or least_loaded rule chooses from. */
export const MAX_ASSIGN_LOGINS = 20;

/**
 * Asks up to `count` reviewers, fewer by those already asked, never the
 * author or a bot; nothing when `count` are asked already.
 */
export type AssignReviewers = {
  kind: "assign_reviewers";
  strategy: AssignStrategy;
  /** 1 to MAX_ASSIGN_COUNT. */
  count: number;
  /** round_robin and least_loaded only (and required): who to choose from, in turn order. */
  logins?: string[] | undefined;
  /** Owners of changed files in CODEOWNERS at the base are chosen before the rest. */
  codeOwnersFirst?: boolean | undefined;
};

/** The actions written on the pull request as the ocra bot, which only a self-hosted server has. */
export const BOT_ACTIONS: readonly AutomationActionKind[] = [
  "add_labels",
  "request_reviewers",
  "comment",
  "assign_reviewers",
];

export type AutomationRuleView = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  /** False when an action needs the ocra bot and this server has none: they are skipped. */
  runsHere: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * How an action went: `needs_self_hosted` when the server has no bot,
 * `not_enrolled` when the pull request's repository is not one the account
 * enrolled, `unreached` when the platform or the chat did not answer. An
 * assignment is `enough_reviewers` when the pull request had its count
 * asked already, `already_assigned` when the rule assigned on it before
 * (it opened again), `no_candidates` when no one was left to ask.
 */
export type AutomationActionOutcome =
  | "done"
  | "enough_reviewers"
  | "already_assigned"
  | "no_candidates"
  | "refused"
  | "unreached"
  | "needs_self_hosted"
  | "not_enrolled"
  | "channel_gone";

export type AutomationRunView = {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: AutomationTrigger;
  /** `owner/repo#7`. */
  pull: string;
  /** running while its actions are under way; partial when some failed; skipped when not tried. */
  outcome: (typeof AUTOMATION_RUN_OUTCOMES)[number];
  /** Why it was skipped; null otherwise. */
  reason: AutomationSkipReason | null;
  actions: { kind: AutomationActionKind; outcome: AutomationActionOutcome }[];
  /** How many times its actions were tried. */
  attempts: number;
  /** When the actions the platform did not answer are tried again; null when none will be. */
  retryAt: string | null;
  createdAt: string;
};

/**
 * What a run tries again: the pull request, and the actions (by their place
 * in the run) the platform did not answer, as the rule said them then.
 */
export type AutomationRetry = {
  reviewRepoId: string;
  number: number;
  actions: { index: number; action: AutomationAction }[];
};

export const AUTOMATION_RUN_OUTCOMES = ["running", "done", "partial", "failed", "skipped"] as const;

/**
 * A pull request as a dry run describes it; what it leaves out matches no
 * condition on it. Optional fields may be undefined: a schema's output is.
 */
export type AutomationPullFacts = {
  repoId?: string | undefined;
  author?: string | undefined;
  baseBranch?: string | undefined;
  title?: string | undefined;
  labels?: string[] | undefined;
  critical?: boolean | undefined;
  verdict?: Verdict | undefined;
  /** The files it changes; a rule on paths is skipped without them. */
  paths?: string[] | undefined;
};

export type AutomationMatchView = {
  ruleId: string;
  name: string;
  actions: AutomationActionKind[];
};

/** A rule a dry run could not decide. */
export type AutomationSkipView = {
  ruleId: string;
  name: string;
  reason: AutomationSkipReason;
};
