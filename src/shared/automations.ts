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
};

export type AutomationActionKind = AutomationAction["kind"];

export type AutomationAction =
  | { kind: "add_labels"; labels: string[] }
  | { kind: "request_reviewers"; reviewers: string[] }
  /** Plain text, posted as the ocra bot. */
  | { kind: "comment"; body: string }
  /** One of the account's notification channels. */
  | { kind: "notify"; channelId: string }
  /** Queued only: the pull request's head is not reviewed. */
  | { kind: "skip_review" };

/** The actions written on the pull request as the ocra bot, which only a self-hosted server has. */
export const BOT_ACTIONS: readonly AutomationActionKind[] = [
  "add_labels",
  "request_reviewers",
  "comment",
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
 * enrolled, `unreached` when the platform or the chat did not answer.
 */
export type AutomationActionOutcome =
  | "done"
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
  /** running while its actions are under way; partial when some failed. */
  outcome: "running" | "done" | "partial" | "failed";
  actions: { kind: AutomationActionKind; outcome: AutomationActionOutcome }[];
  createdAt: string;
};

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
};

export type AutomationMatchView = {
  ruleId: string;
  name: string;
  actions: AutomationActionKind[];
};
