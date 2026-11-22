import { sha256Hex } from "../crypto.js";
import type { Row, Scoped } from "../db/scoped.js";
import type { PostedStatus, PullFacts } from "../platforms/merge-status.js";
import { type CodePlatform, repoIdentity } from "../platforms/platform.js";
import { type MergeChecksReportView, pullPath } from "../shared/index.js";
import { type CheckConfig, evaluateChecks, type HeadReview } from "./evaluate.js";
import { withEngineIds } from "./instruction.js";

// A pull request's checks: its enrolled repository's configuration, the
// pull request as the token reads it, and the stored review of its head.

/** An enrolled repository's checks, at most this many. */
export const MAX_CHECKS = 20;

const KIND_TITLE = {
  linked_issue: "Linked issue",
  title: "Title",
  description: "Description",
  size: "Size",
  critical_findings: "Critical findings",
  instruction: "Instruction",
} as const;

/** An enrolled repository's checks, oldest first. */
export async function checksOf(data: Scoped, reviewRepoId: string) {
  const rows = await data.find("mergeChecks", { reviewRepoId }, MAX_CHECKS);
  return rows.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

/**
 * The newest review this account uploaded of the head, named as the CLI
 * names a repository, so a review of the same path on another host is not
 * this one. Its unresolved critical findings are the open ones, or its
 * critical count when it shared no findings.
 */
export async function headReview(
  data: Scoped,
  platform: CodePlatform,
  repo: Row<"reviewRepos">,
  number: number,
  head: string,
): Promise<HeadReview> {
  const [review] = await data.listNewest("reviews", 1, {
    prRepository: repoIdentity(platform, repo.fullName),
    prNumber: number,
    prHeadSha: head,
  });
  if (!review) return null;
  const uploaded = {
    linkedTasks: review.linkedTasks ?? undefined,
    mergeChecks: review.mergeChecks ?? undefined,
  };
  const shared = await data.count("findings", { reviewId: review.id });
  if (shared === 0) return { unresolvedCritical: review.critical, ...uploaded };
  const open = await data.count("findings", {
    reviewId: review.id,
    severity: "critical",
    status: "open",
  });
  return { unresolvedCritical: open, ...uploaded };
}

export type PullEvaluation =
  | { report: MergeChecksReportView }
  | { report: null; reason: "no_checks" | "unreachable" };

/** The report on the pull request's current head, read with token unless `known` came with another read. */
export async function evaluatePull(
  data: Scoped,
  platform: CodePlatform,
  token: string,
  repo: Row<"reviewRepos">,
  number: number,
  known: PullFacts | null = null,
): Promise<PullEvaluation> {
  const checks: CheckConfig[] = await withEngineIds(
    (await checksOf(data, repo.id)).filter((c) => c.mode !== "off"),
  );
  if (checks.length === 0) return { report: null, reason: "no_checks" };
  const facts = known ?? (await platform.mergeStatus.facts(token, repo.fullName, number));
  if (!facts) return { report: null, reason: "unreachable" };
  const review = await headReview(data, platform, repo, number, facts.head);
  return { report: evaluateChecks(checks, facts, review, repo.holdUnreviewed) };
}

/** What the report's result is known by: the same result is posted once. */
export const digestOf = (report: MergeChecksReportView) =>
  sha256Hex(JSON.stringify([report.head, report.conclusion, report.results]));

/** The report as the platform shows it. */
export function statusOf(report: MergeChecksReportView, detailsUrl: string): PostedStatus {
  const failed = report.results.filter((r) => r.outcome === "failed");
  const blocking = failed.filter((r) => r.mode === "block").length;
  const waiting = report.results.filter((r) => r.outcome === "not_evaluated").length;
  const notYet = `${waiting} check${waiting === 1 ? "" : "s"} not evaluated yet`;
  const title =
    blocking > 0
      ? `${blocking} blocking check${blocking === 1 ? "" : "s"} failed`
      : report.conclusion === "pending"
        ? `Waiting for the review: ${notYet}`
        : failed.length > 0
          ? `Passed with ${failed.length} warning${failed.length === 1 ? "" : "s"}`
          : waiting > 0
            ? notYet
            : "All checks passed";
  const summary = report.results
    .map((r) => {
      // A check not evaluated says so in its detail.
      const what = r.outcome === "not_evaluated" ? r.detail : `${r.outcome}, ${r.detail}`;
      const how = r.mode === "block" ? "blocking" : "warning";
      return `- **${KIND_TITLE[r.kind]}** (${how}): ${what}`;
    })
    .join("\n");
  return { conclusion: report.conclusion, title, summary, detailsUrl };
}

/** The pull request's page in the console. */
export const consolePullUrl = (
  publicUrl: string,
  repo: Pick<Row<"reviewRepos">, "platform" | "fullName">,
  number: number,
) => new URL(pullPath(repo.platform, repo.fullName, number), publicUrl).toString();
