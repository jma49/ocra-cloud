import { useEffect, useMemo, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import type { ReviewSource, ReviewWalkthroughView, Verdict } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { useCached } from "../cache.js";
import { ago, sourceLabel, time } from "../format.js";
import { type FocusedFinding, ImpactRail } from "../impact/rail.js";
import { useImpact } from "../impact/use-impact.js";
import { pullPath } from "../pull/path.js";
import { Link } from "../router.js";
import { LoadError, Loading, PageHead, Seg } from "../ui.js";
import { type Finding, FindingEvent } from "./review-finding.js";
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
        <div className="card empty-hero">
          <h3>Review not found</h3>
          <p>It may have passed the 90-day retention, or been deleted.</p>
          <Link to="/reviews" className={buttonVariants({ variant: "outline" })}>
            Back to reviews
          </Link>
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
          <span className="mono subtle">
            {r.prRepository && r.prNumber ? `#${r.prNumber} · ${r.prRepository}` : r.repo}
          </span>
          <h1>Review of {r.repo}</h1>
        </div>
        {data.walkthrough && <Walkthrough w={data.walkthrough} />}
        <div className="review-tabs">
          <span className="caps">
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
        <ol className="timeline">
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
          {shown.map((f) => (
            <FindingEvent
              key={f.id}
              f={f}
              impact={impact}
              focused={focused?.id === f.id}
              onImpact={() => setFocused(focused?.id === f.id ? null : f)}
              canFix={pull !== null}
            />
          ))}
        </ol>
        {data.findings.length === 0 && (
          <div className="card empty-hero">
            <h3>No findings stored for this review</h3>
            <p>
              Findings are kept only when you share them (Settings). Counts are always kept; turn
              sharing on to see findings of later reviews here.
            </p>
            <Link to="/settings" className={buttonVariants({ variant: "outline" })}>
              Open settings
            </Link>
          </div>
        )}
      </section>
    </div>
  );
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
          <span className="badge badge-warn">{r.warning} warning</span>
          <span className="badge">{r.suggestion} suggestion</span>
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
        <dt>Source</dt>
        <dd>{sourceLabel(r.source)}</dd>
        <dt>Reviewed</dt>
        <dd>{time(r.createdAt)}</dd>
        <dt>Run</dt>
        <dd className="mono">{r.runId}</dd>
      </dl>
      <div className="prop-actions">
        <Link to="/reviews" className={buttonVariants({ variant: "outline" })}>
          All reviews
        </Link>
        <a
          className={buttonVariants({ variant: "outline" })}
          href={`/api/reviews/${r.id}/export`}
          download
        >
          Download JSON
        </a>
      </div>
    </div>
  );
}
