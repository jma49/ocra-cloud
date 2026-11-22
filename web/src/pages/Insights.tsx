import ChartColumn from "lucide-react/icons/chart-column";
import { lazy, Suspense, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind } from "../../../src/shared/index.js";
import { api, type Reviews } from "../api.js";
import { useCached } from "../cache.js";
import { count, num, period, usd } from "../format.js";
import { Cycle } from "../insights/cycle.js";
import { FlowSection } from "../insights/flow.js";
import { ReviewLoadSection } from "../insights/reviewers.js";
import { daily, quantile } from "../insights/series.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead, Seg } from "../ui.js";

// How the reviews went: what they found, what they cost and how long they
// took, from the uploaded reviews; and what the decisions in the findings
// inbox say about them: of the findings someone marked fixed or dismissed,
// how many were right, per reviewer, severity, category and verification,
// and why the rest were dismissed. Only shared findings count there.

// The charts measure their labels once, so they wait for the console's font.
const Charts = lazy(() =>
  Promise.all([import("../insights/charts.js"), document.fonts.ready]).then(([m]) => m),
);

type Row = {
  key: string | null;
  total: number;
  open: number;
  fixed: number;
  dismissed: number;
  acceptanceRate: number | null;
};
type Insights = {
  days: number;
  total: Row;
  byReviewer: Row[];
  bySeverity: Row[];
  byCategory: Row[];
  byVerification: Row[];
  dismissReasons: { key: string | null; n: number }[];
};

const REASON: Record<string, string> = {
  false_positive: "False positive",
  not_important: "Not important",
  wrong_fix: "Wrong fix",
  already_known: "Already known",
};
const rate = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

function Breakdown(props: { title: string; rows: Row[]; none: string }) {
  if (props.rows.length === 0) return null;
  return (
    <div className="section card">
      <div className="card-head">
        <h3>{props.title}</h3>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th className="num">Findings</th>
              <th className="num hide-narrow">Open</th>
              <th className="num">Fixed</th>
              <th className="num hide-narrow">Dismissed</th>
              <th className="num">Accepted</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.key ?? ""}>
                <td>{r.key ?? <span className="subtle">{props.none}</span>}</td>
                <td className="num">{num(r.total)}</td>
                <td className="num hide-narrow">{num(r.open)}</td>
                <td className="num">{num(r.fixed)}</td>
                <td className="num hide-narrow">{num(r.dismissed)}</td>
                <td className="num">{rate(r.acceptanceRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** `runner`: the server reviews enrolled repositories itself, so their webhooks record the flow. */
export function Insights(props: { runner: boolean; platforms: readonly CodePlatformKind[] }) {
  const [days, setDays] = useState(30);
  const quality = useCached(`/findings/insights?days=${days}`, () =>
    api<Insights>(`/findings/insights?days=${days}`),
  );
  const runs = useCached(`/reviews?days=${days}`, () => api<Reviews>(`/reviews?days=${days}`));
  const series = useMemo(() => runs.data && daily(runs.data.reviews, days), [runs.data, days]);
  const error = quality.error ?? runs.error;
  const reload = () => {
    quality.reload();
    runs.reload();
  };
  const data = quality.data;
  return (
    <>
      <PageHead
        title="Insights"
        sub="What the reviews found, what they cost and how long they took; and, of the findings someone decided on in Findings, how often they were right."
        actions={
          <Seg label="Period" value={days} onChange={setDays} options={[7, 30, 90].map(period)} />
        }
      />
      {error && !(data && runs.data) ? (
        <LoadError what="insights" error={error} retry={reload} />
      ) : !(data && runs.data && series) ? (
        <Loading what="insights" />
      ) : runs.data.summary.reviews === 0 && data.total.total === 0 ? (
        <div className="card">
          <EmptyState
            icon={ChartColumn}
            title="No reviews in this period"
            action={
              <Button variant="outline" render={<Link to="/settings" />}>
                Open settings
              </Button>
            }
          >
            Reviews signed in to ocra Cloud upload their results; turn on sharing in Settings to see
            their findings.
          </EmptyState>
        </div>
      ) : (
        <>
          <Kpis runs={runs.data} quality={data} />
          {runs.data.reviews.length < runs.data.summary.reviews && (
            <p className="muted small">
              The charts show the newest {num(runs.data.reviews.length)} of{" "}
              {num(runs.data.summary.reviews)} reviews.
            </p>
          )}
          <div className="chart-grid">
            <Suspense fallback={<Loading what="the charts" />}>
              <Charts
                daily={series}
                acceptance={data.byReviewer.flatMap((r) =>
                  r.key && r.acceptanceRate !== null
                    ? [{ reviewer: r.key, rate: r.acceptanceRate }]
                    : [],
                )}
                reasons={data.dismissReasons.map((r) => ({
                  reason: REASON[r.key ?? ""] ?? r.key ?? "No reason",
                  n: r.n,
                }))}
              />
            </Suspense>
          </div>
          <Breakdown title="By reviewer" rows={data.byReviewer} none="(none)" />
          <Breakdown title="By severity" rows={data.bySeverity} none="(none)" />
          <Breakdown title="By verification" rows={data.byVerification} none="Not verified" />
          <Breakdown title="By category (top 20)" rows={data.byCategory} none="No category" />
        </>
      )}
      {props.runner && (
        <>
          <FlowSection days={days} />
          <ReviewLoadSection days={days} />
        </>
      )}
      <Cycle days={days} platforms={props.platforms} />
    </>
  );
}

function Kpis(props: { runs: Reviews; quality: Insights }) {
  const s = props.runs.summary;
  const times = props.runs.reviews.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
  const median = quantile(times, 0.5);
  const t = props.quality.total;
  return (
    <div className="stats stats-6">
      <div className="card stat">
        <div className="stat-label">Reviews</div>
        <div className="stat-value">{num(s.reviews)}</div>
        <div className="stat-note">{count(s.repositories, "repository", "repositories")}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Findings</div>
        <div className="stat-value">{num(s.findings)}</div>
        <div className="stat-note">{count(s.blocking, "blocking review")}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Critical</div>
        <div className="stat-value">{num(s.critical)}</div>
        <div className="stat-note">{count(s.fixed, "finding")} fixed</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Accepted</div>
        <div className="stat-value">{rate(t.acceptanceRate)}</div>
        <div className="stat-note">of {num(t.fixed + t.dismissed)} decided</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Review time</div>
        <div className="stat-value">{median === null ? "–" : `${Math.round(median)}s`}</div>
        <div className="stat-note">median</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Spend</div>
        <div className="stat-value">{usd(s.costUsd)}</div>
        <div className="stat-note">
          {s.reviews ? `${usd(s.costUsd / s.reviews)} a review` : "–"}
        </div>
      </div>
    </div>
  );
}
