import type { PullFacts } from "../platforms/merge-status.js";
import type {
  LinkedTaskView,
  MergeCheckKind,
  MergeCheckResultView,
  MergeCheckSettings,
  MergeChecksConclusion,
  MergeChecksReportView,
} from "../shared/index.js";
import { judgeLinkedTasks } from "./linked-tasks.js";
import { settingsOf } from "./settings.js";

// The deterministic checks, judged from what the platform says of the pull
// request and what ocra stored of its head's review. A check the server
// cannot judge yet says why and never fails the pull request.

export type CheckConfig = {
  id: string;
  kind: MergeCheckKind;
  mode: "off" | "warn" | "block";
  settings: unknown;
};

/**
 * The stored review of the head: its unresolved critical findings and the
 * tasks it found linked (undefined when it did not look); null when there is none.
 */
export type HeadReview = {
  unresolvedCritical: number;
  linkedTasks?: readonly LinkedTaskView[] | undefined;
} | null;

type Judged = Pick<MergeCheckResultView, "outcome" | "detail">;

const passed = (detail: string): Judged => ({ outcome: "passed", detail });
const failed = (detail: string): Judged => ({ outcome: "failed", detail });
const waiting = (detail: string): Judged => ({ outcome: "not_evaluated", detail });

/** Whether text matches a glob of `*` (any run) and `?` (one character); linear backtracking. */
export function globMatches(glob: string, text: string): boolean {
  const g = [...glob];
  const t = [...text];
  let gi = 0;
  let ti = 0;
  let star = -1;
  let resume = 0;
  while (ti < t.length) {
    if (gi < g.length && (g[gi] === "?" || (g[gi] !== "*" && g[gi] === t[ti]))) {
      gi++;
      ti++;
    } else if (gi < g.length && g[gi] === "*") {
      star = gi++;
      resume = ti;
    } else if (star >= 0) {
      gi = star + 1;
      ti = ++resume;
    } else {
      return false;
    }
  }
  while (gi < g.length && g[gi] === "*") gi++;
  return gi === g.length;
}

/** The text without HTML comments, which pull request templates leave as hints. */
function withoutComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

/** The Markdown ATX headings of a text, case-folded. */
function headingsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let level = 0;
    while (line[level] === "#") level++;
    if (level < 1 || level > 6 || (line[level] !== " " && line[level] !== "\t")) continue;
    let end = line.length;
    while (end > level && (line[end - 1] === "#" || line[end - 1] === " ")) end--;
    found.add(line.slice(level, end).trim().toLowerCase());
  }
  return found;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function judge<K extends MergeCheckKind>(
  kind: K,
  s: MergeCheckSettings[K],
  facts: PullFacts,
  review: HeadReview,
): Judged {
  switch (kind) {
    case "linked_issue":
      return judgeLinkedTasks(s as MergeCheckSettings["linked_issue"], review?.linkedTasks);
    case "instruction":
      return waiting(
        "not evaluated yet: plain-language checks need an ocra release that judges them",
      );
    case "title": {
      const t = s as MergeCheckSettings["title"];
      const byPrefix = t.prefixes?.some((p) => facts.title.startsWith(p)) ?? false;
      const byGlob = t.glob !== undefined && globMatches(t.glob, facts.title);
      if (byPrefix || byGlob) return passed("the title has the expected form");
      const wanted = [
        ...(t.prefixes ? [`start with ${t.prefixes.map((p) => `"${p}"`).join(" or ")}`] : []),
        ...(t.glob !== undefined ? [`match "${t.glob}"`] : []),
      ];
      return failed(`the title does not ${wanted.join(" or ")}`);
    }
    case "description": {
      const text = withoutComments(facts.description).trim();
      if (text === "") return failed("the description is empty");
      const wanted = (s as MergeCheckSettings["description"]).headings ?? [];
      const have = headingsOf(text);
      const missing = wanted.filter((h) => !have.has(h.toLowerCase()));
      if (missing.length > 0) {
        return failed(`the description has no ${missing.map((h) => `"${h}"`).join(", ")} section`);
      }
      return passed(
        wanted.length > 0 ? "the description has every section" : "the description is filled in",
      );
    }
    case "size": {
      const { maxFiles, maxLines } = s as MergeCheckSettings["size"];
      const over = [
        ...(maxFiles !== undefined && facts.files > maxFiles
          ? [`${plural(facts.files, "file")} changed, more than ${maxFiles}`]
          : []),
        ...(maxLines !== undefined && facts.lines > maxLines
          ? [`${plural(facts.lines, "line")} changed, more than ${maxLines}`]
          : []),
      ];
      const atLeast = facts.exact ? "" : "at least ";
      if (over.length > 0) return failed(atLeast + over.join("; "));
      if (!facts.exact)
        return waiting("not evaluated: the pull request has more files than are counted");
      return passed(`${plural(facts.files, "file")} and ${plural(facts.lines, "line")} changed`);
    }
    case "critical_findings":
      if (!review) return waiting("not evaluated yet: ocra has not reviewed this head");
      return review.unresolvedCritical > 0
        ? failed(`${plural(review.unresolvedCritical, "unresolved critical finding")} on this head`)
        : passed("no unresolved critical finding on this head");
  }
  return waiting("not evaluated: an unknown check");
}

/** The report of the enabled checks on the pull request's head, in the order given. */
export function evaluateChecks(
  checks: readonly CheckConfig[],
  facts: PullFacts,
  review: HeadReview,
): MergeChecksReportView {
  const results: MergeCheckResultView[] = [];
  for (const check of checks) {
    if (check.mode === "off") continue;
    const settings = settingsOf(check.kind, check.settings);
    const judged = settings
      ? judge(check.kind, settings, facts, review)
      : waiting("not evaluated: its settings are no longer valid");
    results.push({ id: check.id, kind: check.kind, mode: check.mode, ...judged });
  }
  return { head: facts.head, conclusion: conclusionOf(results), results };
}

function conclusionOf(results: readonly MergeCheckResultView[]): MergeChecksConclusion {
  const failing = results.filter((r) => r.outcome === "failed");
  if (failing.some((r) => r.mode === "block")) return "failure";
  return failing.length > 0 ? "neutral" : "success";
}
