import { type Owner, ownerGroupsOfPath, parseCodeOwners } from "../codeowners.js";
import type { ReadinessFacts } from "../platforms/readiness.js";
import type {
  CodeOwnerGroupView,
  CodePlatformKind,
  MergeChecksReportView,
  ReadinessItem,
  ReadinessState,
} from "../shared/index.js";

// Each requirement judged from what the platform answered: a value it did
// not give is unknown, never assumed met. Pure: no I/O.

/** The pre-merge checks' report on the head; `none` when the repository has none. */
export type PremergeOutcome =
  | { report: MergeChecksReportView; title: string }
  | "none"
  | "unreachable";

const WORST: readonly ReadinessState[] = ["unmet", "pending", "unknown", "met"];

export const worstOf = (states: readonly ReadinessState[]): ReadinessState =>
  WORST.find((s) => states.includes(s)) ?? "met";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const named = (names: readonly string[], max = 3) =>
  names.length <= max
    ? names.join(", ")
    : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

/** Approvals that still count: one of an earlier head only when the platform keeps those. */
const countingApprovals = (facts: ReadinessFacts) =>
  facts.reviews.approvals.filter((a) => a.atHead || facts.reviews.dismissesStale !== true);

function draftItem(facts: ReadinessFacts): ReadinessItem {
  return facts.draft
    ? { kind: "draft", state: "unmet", detail: "Still a draft" }
    : { kind: "draft", state: "met", detail: "Ready for review" };
}

function conflictsItem(facts: ReadinessFacts): ReadinessItem {
  if (facts.conflicts === null) {
    return { kind: "conflicts", state: "pending", detail: "The platform is still checking" };
  }
  return facts.conflicts
    ? { kind: "conflicts", state: "unmet", detail: "Conflicts with the base branch" }
    : { kind: "conflicts", state: "met", detail: "No conflicts with the base branch" };
}

function approvalsItem(facts: ReadinessFacts): ReadinessItem {
  const { required, decision, dismissesStale } = facts.reviews;
  const counting = countingApprovals(facts).length;
  const stale = facts.reviews.approvals.filter((a) => !a.atHead).length;
  const given =
    required === null
      ? `${plural(counting, "approval")}; the token cannot read how many are required`
      : required === 0
        ? `No approval is required (${counting} given)`
        : `${counting} of ${required} required approvals`;
  const staleNote =
    stale === 0
      ? ""
      : `; ${plural(stale, "approval")} of an earlier head ${dismissesStale ? "no longer count" : "still count"}`;
  const detail = given + staleNote;
  if (decision === "changes_requested") {
    return { kind: "approvals", state: "unmet", detail: `Changes requested; ${detail}` };
  }
  const state: ReadinessState =
    decision === "approved" || decision === "none_required"
      ? "met"
      : decision === "review_required"
        ? "unmet"
        : required === null
          ? "unknown"
          : counting >= required
            ? "met"
            : "unmet";
  return { kind: "approvals", state, detail };
}

const ownerKey = (o: Owner) => `${o.kind}:${o.name.toLowerCase()}`;

function groupsFromFile(
  facts: ReadinessFacts,
  flavor: CodePlatformKind,
  text: string,
  paths: readonly string[],
): CodeOwnerGroupView[] {
  const file = parseCodeOwners(text, flavor);
  const groups = new Map<string, { owners: Owner[]; files: number }>();
  for (const path of paths) {
    for (const owners of ownerGroupsOfPath(file, path)) {
      const key = owners.map(ownerKey).sort().join(" ");
      const seen = groups.get(key);
      if (seen) seen.files++;
      else groups.set(key, { owners, files: 1 });
    }
  }
  const approvals = countingApprovals(facts);
  return [...groups.values()].map(({ owners, files }) => {
    const approvedBy = approvals
      .filter((a) =>
        owners.some((o) =>
          o.kind === "user"
            ? o.name.toLowerCase() === a.login.toLowerCase()
            : o.kind === "team" && a.teams.some((t) => t.toLowerCase() === o.name.toLowerCase()),
        ),
      )
      .map((a) => a.login);
    // On GitLab an @name may be a group; teams, roles and emails are not expanded.
    const unresolvable = owners.some((o) => flavor === "gitlab" || o.kind !== "user");
    return {
      owners: owners.map((o) => o.name),
      files,
      state: approvedBy.length > 0 ? "met" : unresolvable ? "unknown" : "unmet",
      approvedBy,
      required: facts.reviews.requiresCodeOwners,
    } satisfies CodeOwnerGroupView;
  });
}

type OwnersJudged = { item: ReadinessItem; groups: CodeOwnerGroupView[] };

function codeOwnersItem(facts: ReadinessFacts, flavor: CodePlatformKind): OwnersJudged {
  const none = (state: ReadinessState, detail: string): OwnersJudged => ({
    item: { kind: "code_owners", state, detail },
    groups: [],
  });
  let groups: CodeOwnerGroupView[];
  let note = "";
  if (facts.ownerRules) {
    groups = facts.ownerRules.map((r) => ({
      owners: [r.name, ...r.owners],
      files: null,
      state: r.approved ? "met" : "unmet",
      approvedBy: r.approvedBy,
      required: r.required,
    }));
  } else {
    const file = facts.codeowners;
    if (file === "unreadable") return none("unknown", "The token could not read CODEOWNERS");
    if (file === null) return none("met", "No CODEOWNERS file");
    if (file.text === null) return none("unknown", `${file.path} is too large or not text`);
    if (!facts.changed) return none("unknown", "The changed files could not be read");
    groups = groupsFromFile(facts, flavor, file.text, facts.changed.paths);
    if (facts.changed.truncated) note = ` (of the first ${facts.changed.paths.length} files)`;
  }
  if (groups.length === 0) return none("met", `No code owners for the changed files${note}`);
  const approved = groups.filter((g) => g.state === "met").length;
  const summary = `${approved} of ${plural(groups.length, "owner group")} approved${note}`;
  const states = groups
    .filter((g) => g.state !== "met" && g.required !== false)
    .map((g) => (g.required === null ? "unknown" : g.state));
  const waiting = groups.filter((g) => g.state === "unmet" && g.required === true);
  // The platform's own decision already weighs the code owners it requires.
  const state = facts.reviews.decision === "approved" ? "met" : worstOf(states);
  const detail =
    state === "unmet" && waiting.length > 0
      ? `${summary}; waiting on ${named(waiting.map((g) => g.owners.join(" or ")))}`
      : states.length > 0 && state === "unknown"
        ? `${summary}; the token cannot read whether the rest must approve`
        : approved < groups.length && states.length === 0
          ? `${summary}; the rest are not required`
          : summary;
  return { item: { kind: "code_owners", state, detail }, groups };
}

function checksItem(facts: ReadinessFacts): ReadinessItem {
  const item = (state: ReadinessState, detail: string): ReadinessItem => ({
    kind: "required_checks",
    state,
    detail,
  });
  const checks = facts.checks;
  if (!checks) return item("unknown", "The token cannot read the head's checks");
  const names = new Set([
    ...(checks.required ?? []),
    ...checks.runs.filter((r) => r.required === true).map((r) => r.name),
  ]);
  const runs = checks.runs.filter((r) => names.has(r.name));
  const failed = [...new Set(runs.filter((r) => r.state === "failed").map((r) => r.name))];
  if (failed.length > 0) return item("unmet", `Failed: ${named(failed)}`);
  if (facts.mergeable === true) return item("met", "The platform reports nothing blocking");
  const reported = new Set(runs.map((r) => r.name));
  const waiting = [
    ...new Set([
      ...[...names].filter((n) => !reported.has(n)),
      ...runs.filter((r) => r.state === "pending").map((r) => r.name),
    ]),
  ];
  if (waiting.length > 0) return item("pending", `Waiting for ${named(waiting)}`);
  if (checks.truncated) return item("unknown", "More checks than one reading lists");
  if (names.size > 0) return item("met", `${plural(names.size, "required check")} passed`);
  if (checks.required !== null) return item("met", "No check is required");
  return item(
    "unknown",
    checks.runs.length > 0
      ? `None of the head's ${plural(checks.runs.length, "check")} is marked required; the token cannot read the branch rule`
      : "The token cannot read which checks are required",
  );
}

function threadsItem(facts: ReadinessFacts): ReadinessItem {
  const t = facts.threads;
  if (!t) return { kind: "threads", state: "unknown", detail: "The threads could not be read" };
  if (t.unresolved > 0) {
    const count = plural(t.unresolved, "unresolved thread");
    return { kind: "threads", state: "unmet", detail: t.truncated ? `At least ${count}` : count };
  }
  return t.truncated
    ? { kind: "threads", state: "unknown", detail: "More threads than one reading lists" }
    : { kind: "threads", state: "met", detail: "No unresolved threads" };
}

const PREMERGE_STATE = {
  success: "met",
  neutral: "met",
  failure: "unmet",
  pending: "pending",
} as const satisfies Record<MergeChecksReportView["conclusion"], ReadinessState>;

function premergeItem(premerge: PremergeOutcome): ReadinessItem {
  if (premerge === "none") {
    return { kind: "premerge_checks", state: "met", detail: "No pre-merge checks set up" };
  }
  if (premerge === "unreachable") {
    return { kind: "premerge_checks", state: "unknown", detail: "Could not evaluate the checks" };
  }
  return {
    kind: "premerge_checks",
    state: PREMERGE_STATE[premerge.report.conclusion],
    detail: premerge.title,
  };
}

export function readinessItems(
  facts: ReadinessFacts,
  flavor: CodePlatformKind,
  premerge: PremergeOutcome,
): { items: ReadinessItem[]; groups: CodeOwnerGroupView[] } {
  const owners = codeOwnersItem(facts, flavor);
  return {
    items: [
      draftItem(facts),
      conflictsItem(facts),
      approvalsItem(facts),
      owners.item,
      checksItem(facts),
      threadsItem(facts),
      premergeItem(premerge),
    ],
    groups: owners.groups,
  };
}
