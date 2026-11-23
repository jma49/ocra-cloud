import { type AuditEventView, type AuditKind, LIMIT_OFF } from "../../../src/shared/index.js";

/** Each kind's name in the filter, under the part of the console it belongs to. */
export const KIND_GROUPS: { label: string; kinds: [AuditKind, string][] }[] = [
  {
    label: "Sign-in",
    kinds: [
      ["session.signed_in", "Signed in"],
      ["session.signed_out", "Signed out"],
      ["session.revoked", "Session revoked"],
      ["device.decided", "Terminal sign-in decided"],
      ["token.created", "API token made"],
      ["token.revoked", "API token revoked"],
      ["token.first_used", "API token first used"],
    ],
  },
  {
    label: "Platforms and keys",
    kinds: [
      ["platform.connected", "Platform connected"],
      ["key.saved", "Key saved"],
      ["key.checked", "Key checked"],
      ["key.deleted", "Key deleted"],
    ],
  },
  {
    label: "Settings",
    kinds: [
      ["settings.changed", "Review settings changed"],
      ["sharing.changed", "Sharing changed"],
      ["sharing.hosted_changed", "Hosted findings changed"],
      ["budget.changed", "Budget changed"],
      ["budget.spend_changed", "Spend limit changed"],
    ],
  },
  {
    label: "Notifications",
    kinds: [
      ["channel.added", "Channel added"],
      ["channel.changed", "Channel changed"],
      ["channel.removed", "Channel removed"],
      ["channel.expired", "Unconfirmed channel removed"],
    ],
  },
  {
    label: "Automations",
    kinds: [
      ["automation.added", "Automation added"],
      ["automation.changed", "Automation changed"],
      ["automation.removed", "Automation removed"],
    ],
  },
  {
    label: "Scheduled reports",
    kinds: [
      ["report.added", "Report added"],
      ["report.changed", "Report changed"],
      ["report.removed", "Report removed"],
    ],
  },
  {
    label: "Automatic review",
    kinds: [
      ["auto_review.enrolled", "Repository enrolled"],
      ["auto_review.auto_enroll_changed", "New repositories enrollment switched"],
      ["auto_review.profile_changed", "Profile changed"],
      ["auto_review.automatic_changed", "Automatic review switched"],
      ["auto_review.learn_changed", "Learning from declined findings changed"],
      ["auto_review.unenrolled", "Repository unenrolled"],
      ["auto_review.renamed", "Repository renamed"],
      ["auto_review.paused", "Repository paused"],
      ["auto_review.resumed", "Repository resumed"],
      ["auto_review.access_token_set", "GitLab access token given"],
      ["auto_review.access_token_cleared", "GitLab access token removed"],
      ["auto_review.webhook_added", "GitLab webhook added"],
      ["auto_review.webhook_removed", "GitLab webhook removed"],
      ["auto_review.webhook_secret_rotated", "GitLab webhook secret replaced"],
      ["auto_review.pull_paused", "Pull request's reviews paused"],
      ["auto_review.pull_resumed", "Pull request's reviews resumed"],
    ],
  },
  {
    label: "Live reviews",
    kinds: [
      ["live.link_changed", "Share link changed"],
      ["live.person_added", "Person added"],
      ["live.person_removed", "Person removed"],
    ],
  },
  {
    label: "Pull requests",
    kinds: [
      ["pull.reviewed", "Review sent"],
      ["pull.merged", "Merged"],
      ["pull.fix_applied", "Fix applied"],
      ["pull.reviewers_changed", "Reviewers changed"],
      ["pull.assignees_changed", "Assignees changed"],
      ["pull.branch_updated", "Branch updated"],
      ["merge_when_ready.armed", "Merge when ready set"],
      ["merge_when_ready.cancelled", "Merge when ready cancelled"],
      ["merge_when_ready.merged", "Merged when ready"],
      ["merge_when_ready.closed", "Merge when ready: closed"],
      ["merge_when_ready.disarmed", "Merge when ready stopped"],
      ["merge_when_ready.failed", "Merge when ready failed"],
      ["stack_merge.started", "Stack merge started"],
      ["stack_merge.cancelled", "Stack merge cancelled"],
      ["stack_merge.merged", "Stack merged"],
      ["stack_merge.failed", "Stack merge stopped"],
      ["stack.retargeted", "Moved onto a merged base"],
    ],
  },
];

const PLATFORM: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };
const SIGN_IN: Record<string, string> = {
  github: "GitHub",
  oidc: "single sign-on",
  device: "a code approved in the browser",
};
const KEY_CHECK: Record<string, string> = {
  ok: "verified",
  invalid: "rejected by the provider",
  error: "could not be checked",
};
const VERDICT: Record<string, string> = {
  approve: "Approved",
  request_changes: "Requested changes on",
  comment: "Commented on",
};

// An older event may lack a field its kind keeps now: each phrase reads without it.
const where = (client: string | undefined) => (client === "cli" ? "the terminal" : "a browser");
const named = (value: string | undefined, fallback: string) => value ?? fallback;
const noted = (value: string | null | undefined, open = " (", close = ")") =>
  value ? `${open}${value}${close}` : "";
const checked = (check: string | undefined) =>
  noted(check && (KEY_CHECK[check] ?? check), ": ", "");
const listed = (keys: string[] | undefined) => (keys?.length ? `: ${keys.join(", ")}` : "");
const people = (d: { added?: string[]; removed?: string[] }) => {
  const parts = [
    d.added?.length ? `added ${d.added.join(", ")}` : "",
    d.removed?.length ? `removed ${d.removed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `: ${parts.join("; ")}` : "";
};

const apiToken = (prefix: string | undefined) =>
  prefix ? `the API token ${prefix}` : "an API token";

/** One event as a line a person reads. */
export function describe(e: AuditEventView): string {
  switch (e.kind) {
    case "session.signed_in": {
      const how = e.detail.method ? SIGN_IN[e.detail.method] : undefined;
      return `Signed in from ${where(e.detail.client)}${how ? ` with ${how}` : ""}`;
    }
    case "session.signed_out":
      return `Signed out of ${where(e.detail.client)}`;
    case "session.revoked":
      return e.detail.current ? "Signed out of this session" : "Revoked a session";
    case "device.decided":
      if (e.detail.approved === undefined) return "Decided a terminal sign-in";
      return e.detail.approved ? "Approved a terminal sign-in" : "Refused a terminal sign-in";
    case "token.created":
      return `Made ${apiToken(e.detail.prefix)}${listed(e.detail.scopes)}`;
    case "token.revoked":
      return `Revoked ${apiToken(e.detail.prefix)}`;
    case "token.first_used":
      return `First use of ${apiToken(e.detail.prefix)}`;
    case "platform.connected": {
      const p = e.detail.platform;
      return `Connected ${p ? (PLATFORM[p] ?? p) : "a code platform"}`;
    }
    case "settings.changed":
      return `Changed review settings${listed(e.detail.keys)}`;
    case "sharing.changed":
      if (e.detail.shareFindings === undefined) return "Changed sharing findings";
      return e.detail.shareFindings
        ? "Turned on sharing findings"
        : `Turned off sharing findings${e.detail.deleted ? ` (${e.detail.deleted} removed)` : ""}`;
    case "sharing.hosted_changed":
      if (e.detail.hostedFindings === undefined) return "Changed keeping hosted findings";
      return e.detail.hostedFindings
        ? "Turned on keeping the findings of reviews ocra runs here"
        : `Turned off keeping the findings of reviews ocra runs here${e.detail.deleted ? ` (${e.detail.deleted} removed)` : ""}`;
    case "budget.changed":
      if (e.detail.dailyCalls === undefined) return "Changed the daily budget";
      return e.detail.dailyCalls === null
        ? "Set the daily calls to the default"
        : e.detail.dailyCalls === LIMIT_OFF
          ? "Turned off the limit on daily calls"
          : `Set the daily budget to ${e.detail.dailyCalls} calls`;
    case "budget.spend_changed": {
      const limit = (usd: number | null | undefined) =>
        usd == null ? "the default" : usd === LIMIT_OFF ? "no limit" : `$${usd.toFixed(2)}`;
      return `Set the spend limit to ${limit(e.detail.dailyUsd)} a day and ${limit(e.detail.monthlyUsd)} a month`;
    }
    case "key.saved":
      return `Saved the ${named(e.detail.provider, "provider")} key${checked(e.detail.check)}`;
    case "key.checked":
      return `Checked the ${named(e.detail.provider, "provider")} key${checked(e.detail.check)}`;
    case "key.deleted":
      return `Deleted the ${named(e.detail.provider, "provider")} key`;
    case "channel.added":
      return `Added a ${e.detail.kind ? `${e.detail.kind} ` : ""}notification channel`;
    case "channel.changed":
      return `Changed a notification channel${listed(e.detail.keys)}`;
    case "channel.removed":
      return "Removed a notification channel";
    case "channel.expired":
      return `Removed a ${e.detail.kind ? `${e.detail.kind} ` : ""}notification channel never confirmed`;
    case "automation.added":
      return `Added an automation${noted(e.detail.trigger, " on ", "")}`;
    case "automation.changed":
      return `${e.detail.enabled === false ? "Turned off" : "Changed"} an automation${noted(e.detail.trigger, " on ", "")}`;
    case "automation.removed":
      return "Removed an automation";
    case "report.added":
      return `Added a ${e.detail.cadence ? `${e.detail.cadence} ` : ""}scheduled report`;
    case "report.changed":
      return `${e.detail.enabled === false ? "Turned off" : "Changed"} a scheduled report`;
    case "report.removed":
      return "Removed a scheduled report";
    case "auto_review.enrolled":
      return `Enrolled ${named(e.detail.repo, "a repository")} in automatic review`;
    case "auto_review.auto_enroll_changed":
      return `Turned ${e.detail.enabled === false ? "off" : "on"} enrolling the new repositories of ${named(e.detail.owner, "an installation")}`;
    case "auto_review.profile_changed":
      return `Set the review profile of ${named(e.detail.repo, "a repository")}${noted(e.detail.profile, " to ", "")}`;
    case "auto_review.automatic_changed":
      return `Turned automatic review ${e.detail.automatic === false ? "off" : "on"} for ${named(e.detail.repo, "a repository")}`;
    case "auto_review.learn_changed":
      return `Set learning from declined findings${noted(e.detail.learn, " to ", "")} for ${named(e.detail.repo, "a repository")}`;
    case "auto_review.unenrolled":
      return `Stopped automatic review of ${named(e.detail.repo, "a repository")}`;
    case "auto_review.renamed":
      return `Followed ${named(e.detail.previous, "a repository")} to its new name${noted(e.detail.repo, " ", "")}`;
    case "auto_review.paused":
      return `Paused automatic review of ${named(e.detail.repo, "a repository")}${noted(e.detail.reason, ": ", "")}`;
    case "auto_review.resumed":
      return `Resumed automatic review of ${named(e.detail.repo, "a repository")}`;
    case "auto_review.access_token_set":
      return `Gave ${named(e.detail.repo, "a repository")} a GitLab access token${noted(e.detail.bot, " of ", "")}`;
    case "auto_review.access_token_cleared":
      return `Removed the GitLab access token of ${named(e.detail.repo, "a repository")}`;
    case "auto_review.webhook_added":
      return `Added or updated the GitLab webhook of ${named(e.detail.repo, "a repository")}`;
    case "auto_review.webhook_removed":
      return e.detail.removed === false
        ? `Could not remove the GitLab webhook of ${named(e.detail.repo, "a repository")}: remove it by hand`
        : `Removed the GitLab webhook of ${named(e.detail.repo, "a repository")}`;
    case "auto_review.webhook_secret_rotated":
      return `Made a new webhook secret for ${named(e.detail.repo, "a repository")}: a hook with the old one is no longer accepted`;
    case "auto_review.pull_paused":
      return `Paused the automatic reviews of ${named(e.detail.pull, "a pull request")}`;
    case "auto_review.pull_resumed":
      return `Resumed the automatic reviews of ${named(e.detail.pull, "a pull request")}`;
    case "live.link_changed":
      return e.detail.role
        ? `Shared a live review by link (${e.detail.role})`
        : "Turned off a live review's link";
    case "live.person_added":
      return `Shared a live review with ${named(e.detail.login, "a person")}${noted(e.detail.role)}`;
    case "live.person_removed":
      return "Removed a person from a live review";
    case "pull.reviewed":
      return `${VERDICT[e.detail.verdict ?? ""] ?? "Reviewed"} ${named(e.detail.pull, "a pull request")}`;
    case "pull.merged":
      return `Merged ${named(e.detail.pull, "a pull request")}${noted(e.detail.method)}`;
    case "pull.fix_applied":
      return `Applied a fix to ${named(e.detail.pull, "a pull request")}`;
    case "pull.reviewers_changed":
      return `Changed the reviewers of ${named(e.detail.pull, "a pull request")}${people(e.detail)}`;
    case "pull.assignees_changed":
      return `Changed the assignees of ${named(e.detail.pull, "a pull request")}${people(e.detail)}`;
    case "pull.branch_updated":
      return `Updated the branch of ${named(e.detail.pull, "a pull request")} from its base`;
    case "merge_when_ready.armed":
      return `Set ${named(e.detail.pull, "a pull request")} to merge when ready${noted(e.detail.method)}`;
    case "merge_when_ready.cancelled":
      return `Cancelled merge when ready on ${named(e.detail.pull, "a pull request")}`;
    case "merge_when_ready.merged":
      return `Merged ${named(e.detail.pull, "a pull request")} when ready${noted(e.detail.method)}`;
    case "merge_when_ready.closed":
      return `Merge when ready ended: ${named(e.detail.pull, "the pull request")} was closed`;
    case "merge_when_ready.disarmed":
      return `Merge when ready stopped on ${named(e.detail.pull, "a pull request")}${noted(e.detail.reason, ": ", "")}`;
    case "merge_when_ready.failed":
      return `Merge when ready failed on ${named(e.detail.pull, "a pull request")}${noted(e.detail.reason, ": ", "")}`;
    case "stack_merge.started":
      return `Started merging the stack from ${named(e.detail.pull, "a pull request")}${noted(e.detail.method)}`;
    case "stack_merge.cancelled":
      return `Cancelled the stack merge from ${named(e.detail.pull, "a pull request")}`;
    case "stack_merge.merged":
      return `Merged the stack from ${named(e.detail.pull, "a pull request")}${noted(e.detail.method)}`;
    case "stack_merge.failed":
      return `The stack merge from ${named(e.detail.pull, "a pull request")} stopped${noted(e.detail.reason, ": ", "")}`;
    case "stack.retargeted":
      return `Moved ${named(e.detail.pull, "a pull request")} onto ${e.detail.base ?? "the merged base"}`;
  }
}
