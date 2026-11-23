import type { AuditEventView, AuditKind } from "../../../src/shared/index.js";

/** Each kind's name in the filter, under the part of the console it belongs to. */
export const KIND_GROUPS: { label: string; kinds: [AuditKind, string][] }[] = [
  {
    label: "Sign-in",
    kinds: [
      ["session.signed_in", "Signed in"],
      ["session.signed_out", "Signed out"],
      ["session.revoked", "Session revoked"],
      ["device.decided", "Terminal sign-in decided"],
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
      ["budget.changed", "Budget changed"],
    ],
  },
  {
    label: "Notifications",
    kinds: [
      ["channel.added", "Channel added"],
      ["channel.changed", "Channel changed"],
      ["channel.removed", "Channel removed"],
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
    label: "Automatic review",
    kinds: [
      ["auto_review.enrolled", "Repository enrolled"],
      ["auto_review.profile_changed", "Profile changed"],
      ["auto_review.unenrolled", "Repository unenrolled"],
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
      ["merge_when_ready.armed", "Merge when ready set"],
      ["merge_when_ready.cancelled", "Merge when ready cancelled"],
      ["merge_when_ready.merged", "Merged when ready"],
      ["merge_when_ready.closed", "Merge when ready: closed"],
      ["merge_when_ready.disarmed", "Merge when ready stopped"],
      ["merge_when_ready.failed", "Merge when ready failed"],
    ],
  },
];

const PLATFORM: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };
const SIGN_IN: Record<string, string> = {
  github: "GitHub",
  oidc: "single sign-on",
  device: "a code approved in the browser",
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
const listed = (keys: string[] | undefined) => (keys?.length ? `: ${keys.join(", ")}` : "");

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
    case "budget.changed":
      if (e.detail.dailyCalls === undefined) return "Changed the daily budget";
      return e.detail.dailyCalls === null
        ? "Removed the daily budget"
        : `Set the daily budget to ${e.detail.dailyCalls} calls`;
    case "key.saved":
      return `Saved the ${named(e.detail.provider, "provider")} key${noted(e.detail.check, " (check: ")}`;
    case "key.checked":
      return `Checked the ${named(e.detail.provider, "provider")} key${noted(e.detail.check, ": ", "")}`;
    case "key.deleted":
      return `Deleted the ${named(e.detail.provider, "provider")} key`;
    case "channel.added":
      return `Added a ${e.detail.kind ? `${e.detail.kind} ` : ""}notification channel`;
    case "channel.changed":
      return `Changed a notification channel${listed(e.detail.keys)}`;
    case "channel.removed":
      return "Removed a notification channel";
    case "automation.added":
      return `Added an automation${noted(e.detail.trigger, " on ", "")}`;
    case "automation.changed":
      return `${e.detail.enabled === false ? "Turned off" : "Changed"} an automation${noted(e.detail.trigger, " on ", "")}`;
    case "automation.removed":
      return "Removed an automation";
    case "auto_review.enrolled":
      return `Enrolled ${named(e.detail.repo, "a repository")} in automatic review`;
    case "auto_review.profile_changed":
      return `Set the review profile of ${named(e.detail.repo, "a repository")}${noted(e.detail.profile, " to ", "")}`;
    case "auto_review.unenrolled":
      return `Stopped automatic review of ${named(e.detail.repo, "a repository")}`;
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
  }
}
