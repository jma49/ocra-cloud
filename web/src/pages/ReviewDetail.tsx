import Flag from "lucide-react/icons/flag";
import SearchX from "lucide-react/icons/search-x";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  LinkedTaskView,
  ReviewSource,
  ReviewWalkthroughView,
  Verdict,
} from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { useCached } from "../cache.js";
import { useFixes } from "../fixes/use-fixes.js";
import { ago, count, sourceLabel, time } from "../format.js";
import { type FocusedFinding, ImpactRail } from "../impact/rail.js";
import { useImpact } from "../impact/use-impact.js";
import { useListCursor } from "../list-cursor.js";
import { usePageCommands } from "../page-commands.js";
import { pullPath } from "../pull/path.js";
import { ReviewChat } from "../review-chat/chat.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead, Seg } from "../ui.js";
import { reviewCommands } from "./review-commands.js";
import { type Finding, FindingEvent } from "./review-finding.js";
import { LinkedTasks } from "./review-linked-tasks.js";
import { Walkthrough } from "./review-walkthrough.js";

// One review and, when the account shares findings, its findings (ADR-0028):
// its properties on the left, what happened on a timeline on the right.

type Detail = {
  review: {
    id: string;
    runId: string;
    repo: string;
    source: ReviewSource;
    verdict: Verdict | null;
    complete: boolean;
    critical: number;
    warning: number;
    suggestion: number;
    createdAt: string;
    prRepository: string | null;
    prNumber: number | null;
    prHeadSha?: string | null;
    linkedTasks: LinkedTaskView[] | null;
    /** The ids of the learnings its reviewers were given; null where it did not say. */
    learnings: string[] | null;
  };
  findings: Finding[];
  walkthrough: ReviewWalkthroughView | null;
};
type Review = Detail["review"];

const RANK = { critical: 0, warning: 1, suggestion: 2 } as const;

export function ReviewDetail(props: { id: string; graphs: boolean }) {
  const { data, error, reload } = useCached(`/reviews/${props.id}`, () =>
    api<Detail>(`/reviews/${encodeURIComponent(props.id)}`),
  );
  const pr = data?.review;
  const impact = useImpact(
    pr?.prRepository && pr.prNumber ? { repository: pr.prRepository, number: pr.prNumber } : null,
    props.graphs,
  );
  const pull = pr ? pullOf(pr) : null;
  const withFix = pull !== null && (data?.findings ?? []).some((f) => f.fix !== null);
  const fixes = useFixes(withFix ? `/pulls/fixes/review/${encodeURIComponent(props.id)}` : null);
  const [focused, setFocused] = useState<FocusedFinding | null>(null);
  useEffect(() => {
    if (!focused) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setFocused(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [focused]);
  const [severity, setSeverity] = useState<"all" | Finding["severity"]>("all");
  const shown = useMemo(
    () =>
      (data?.findings ?? [])
        .filter((f) => severity === "all" || f.severity === severity)
        .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file)),
    [data, severity],
  );

  const timeline = useRef<HTMLOListElement>(null);
  const cursor = useListCursor(shown.length, timeline);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpened((was) => {
      const now = new Set(was);
      if (!now.delete(id)) now.add(id);
      return now;
    });
  usePageCommands(
    "This review",
    reviewCommands({
      findings: shown.length,
      move: cursor.move,
      toggleDetails: () => {
        const f = shown[cursor.current];
        if (f) toggle(f.id);
        cursor.show();
      },
      pull: pull ? pullPath(pull.platform, pull.repo, pull.number) : null,
    }),
  );

  if (error && !(error instanceof ApiError && error.status === 404)) {
    return (
      <>
        <PageHead title="Review" />
        <LoadError what="this review" error={error} retry={reload} />
      </>
    );
  }
  if (error) {
    return (
      <>
        <PageHead title="Review" />
        <div className="card">
          <EmptyState
            icon={SearchX}
            title="Review not found"
            action={
              <Button variant="outline" render={<Link to="/reviews" />}>
                Back to reviews
              </Button>
            }
          >
            It may have passed the 90-day retention, or been deleted.
          </EmptyState>
        </div>
      </>
    );
  }
  if (!data)
    return (
      <>
        <PageHead title="Review" />
        <Loading what="the review" />
      </>
    );
  const r = data.review;
  const files = new Set(data.findings.map((f) => f.file)).size;
  return (
    <div className="review-frame">
      <aside className="review-side" aria-label="Properties">
        <Properties r={r} />
        <ImpactRail impact={impact} finding={focused} onClose={() => setFocused(null)} />
      </aside>
      <section className="review-main" aria-label="Activity">
        <div className="review-title">
          <span className="subtle">
            {sourceLabel(r.source)}
            {r.prHeadSha && <span className="mono"> {r.prHeadSha.slice(0, 7)}</span>}
          </span>
          <h1>{titleOf(r)}</h1>
        </div>
        {data.walkthrough && <Walkthrough w={data.walkthrough} />}
        <ReviewChat reviewId={r.id} />
        <div className="review-tabs">
          <span className="quiet-label">
            Activity · {data.findings.length} finding{data.findings.length === 1 ? "" : "s"} in{" "}
            {files} file{files === 1 ? "" : "s"}
          </span>
          {data.findings.length > 0 && (
            <Seg
              label="Severity"
              value={severity}
              options={[
                { value: "all", label: "All" },
                { value: "critical", label: "Critical" },
                { value: "warning", label: "Warning" },
                { value: "suggestion", label: "Suggestion" },
              ]}
              onChange={setSeverity}
            />
          )}
        </div>
        <ol className="timeline" ref={timeline}>
          <li className="event">
            <span className="event-mark" aria-hidden="true" />
            <div className="event-body">
              <div className="event-meta">
                <span>Review ran</span>
                <span className="subtle">{ago(r.createdAt)}</span>
              </div>
              <p className="event-text">
                {sourceLabel(r.source)}, run <span className="mono">{r.runId}</span>.
              </p>
            </div>
          </li>
          {shown.map((f, i) => (
            <FindingEvent
              key={f.id}
              f={f}
              row={i}
              current={cursor.shown && i === cursor.current}
              open={opened.has(f.id)}
              onToggle={() => toggle(f.id)}
              impact={impact}
              focused={focused?.id === f.id}
              onImpact={() => setFocused(focused?.id === f.id ? null : f)}
              canFix={pull !== null}
              before={fixes.find((x) => x.finding === f.id)?.before ?? null}
            />
          ))}
        </ol>
        {data.findings.length === 0 && (
          <div className="card">
            <EmptyState
              icon={Flag}
              title="No findings stored for this review"
              action={
                <Button variant="outline" render={<Link to="/settings" />}>
                  Open settings
                </Button>
              }
            >
              Findings are kept for reviews ocra runs here, and for CLI reviews once you turn on
              sharing (Settings). This review's were not kept; its counts always are.
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}

/** What the review was of, in words: its pull request where it names one, else the repository's hash. */
function titleOf(r: Review): string {
  const pull = pullOf(r);
  return pull ? `Review of ${pull.repo} #${pull.number}` : `Review of ${r.repo}`;
}

/** The pull request a review names, on a platform the console reaches; null for a local review. */
function pullOf(r: Review) {
  if (r.source === "local" || !r.prRepository || !r.prNumber) return null;
  try {
    const repo = new URL(r.prRepository).pathname.slice(1);
    return repo.includes("/") ? { platform: r.source, repo, number: r.prNumber } : null;
  } catch {
    return null;
  }
}

function Properties(props: { r: Review }) {
  const { r } = props;
  const pull = pullOf(r);
  const verdict = !r.complete ? "Incomplete" : (r.verdict ?? "–").replaceAll("_", " ");
  return (
    <div className="props">
      <dl className="prop-list">
        <dt>Verdict</dt>
        <dd className="capitalize">{verdict}</dd>
        <dt>Findings</dt>
        <dd className="sev-counts">
          <span className="badge badge-err">{r.critical} critical</span>
          <span className="badge badge-warn">{count(r.warning, "warning")}</span>
          <span className="badge">{count(r.suggestion, "suggestion")}</span>
        </dd>
        <dt>Repository</dt>
        <dd className="mono">{r.repo}</dd>
        {r.prRepository && r.prNumber && (
          <>
            <dt>Pull request</dt>
            <dd className="mono">
              {pull ? (
                <Link to={pullPath(pull.platform, pull.repo, pull.number)}>
                  {pull.repo}#{pull.number}
                </Link>
              ) : (
                `${r.prRepository}#${r.prNumber}`
              )}
            </dd>
          </>
        )}
        <LinkedTasks tasks={r.linkedTasks ?? null} />
        {r.learnings && r.learnings.length > 0 && (
          <>
            <dt>Learnings</dt>
            <dd>
              <ul className="prop-items mono small">
                {r.learnings.map((id) => (
                  <li key={id}>
                    {pull ? (
                      <Link
                        to={`/learnings?${new URLSearchParams({ platform: pull.platform, repo: pull.repo })}`}
                      >
                        {id}
                      </Link>
                    ) : (
                      id
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>{sourceLabel(r.source)}</dd>
        <dt>Reviewed</dt>
        <dd>{time(r.createdAt)}</dd>
        <dt>Run</dt>
        <dd className="mono">{r.runId}</dd>
      </dl>
      <div className="prop-actions">
        <Button variant="outline" render={<Link to="/reviews" />}>
          All reviews
        </Button>
        <Button variant="outline" render={<a href={`/api/reviews/${r.id}/export`} download />}>
          Download JSON
        </Button>
      </div>
    </div>
  );
}
