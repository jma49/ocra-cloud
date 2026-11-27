import ChartColumn from "lucide-react/icons/chart-column";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodePlatformKind,
  type FindingInsightRow,
  type FindingInsightsView,
  MAX_RULE_ROWS,
  quantile,
} from "../../../src/shared/index.js";
import { api, type Reviews } from "../api.js";
import { useCached } from "../cache.js";
import { count, num, period, usd } from "../format.js";
import { AtRiskSection } from "../insights/at-risk.js";
import { Charts } from "../insights/charts.js";
import { Cycle } from "../insights/cycle.js";
import { FlowSection } from "../insights/flow.js";
import { ImpactSection } from "../insights/impact.js";
import { ReviewLoadSection } from "../insights/reviewers.js";
import { daily } from "../insights/series.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead, Seg, Stat } from "../ui.js";

// How the reviews went: what they found, what they cost and how long they
// took, from the uploaded reviews; and what the decisions in the findings
// inbox say about them: of the findings someone marked fixed or dismissed,
// how many were right, per reviewer, severity, category, verification and rule,
// and why the rest were dismissed. Only shared findings count there.

type Row = FindingInsightRow;
type Insights = FindingInsightsView;

const REASON: Record<string, string> = {
  false_positive: "False positive",
  not_important: "Not important",
  wrong_fix: "Wrong fix",
  already_known: "Already known",
};
const rate = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
/** A share of the findings someone reacted to, with how many that is. */
const reacted = (r: number | null, of: number) => (r === null ? "–" : `${rate(r)} of ${num(of)}`);

/** A vocabulary word ("warning", "verified") as a label. */
const sentence = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

function Breakdown(props: {
  title: string;
  column: string;
  rows: Row[];
  none: string;
  name?: (key: string) => string;
  /** A line under the table, for the rows it leaves out. */
  more?: string | undefined;
}) {
  if (props.rows.length === 0) return null;
  return (
    <div className="section card">
      <div className="card-head">
        <h2>{props.title}</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{props.column}</th>
              <th className="num" title="Shared findings: one for each review that reported it">
                Findings
              </th>
              <th className="num hide-narrow">Open</th>
              <th
                className="num"
                title="Marked fixed in any way: in Findings, by committing ocra's fix or a suggestion, or not found again on a later review"
              >
                Fixed
              </th>
              <th className="num hide-narrow">Dismissed</th>
              <th className="num">Accepted</th>
              <th className="num hide-narrow" title="Of the findings whose comment got a reaction">
                Upvoted
              </th>
              <th className="num hide-narrow" title="Of the findings whose comment got a reaction">
                Downvoted
              </th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.key ?? ""}>
                <td>
                  {r.key ? (
                    (props.name ?? String)(r.key)
                  ) : (
                    <span className="subtle">{props.none}</span>
                  )}
                </td>
                <td className="num">{num(r.total)}</td>
                <td className="num hide-narrow">{num(r.open)}</td>
                <td className="num">{num(r.fixed)}</td>
                <td className="num hide-narrow">{num(r.dismissed)}</td>
                <td className="num">{rate(r.acceptanceRate)}</td>
                <td className="num hide-narrow">{reacted(r.thumbsUpRate, r.reacted)}</td>
                <td className="num hide-narrow">{reacted(r.downvoteRate, r.reacted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.more && <p className="muted small">{props.more}</p>}
    </div>
  );
}

/** A rule's row as `<id> (<kind>)`: its key is `<kind>:<id>`, and an id holds no colon. */
const ruleName = (key: string) => {
  const at = key.indexOf(":");
  return `${key.slice(at + 1)} (${key.slice(0, at)})`;
};

function otherRules(rest: Insights["otherRules"]) {
  if (!rest) return undefined;
  return `And ${count(rest.rules, "more rule")}, with ${count(rest.total, "finding")}: ${rate(rest.acceptanceRate)} accepted.`;
}

/** `runner`: the server reviews enrolled repositories itself, so their webhooks record the flow. */
export function Insights(props: { runner: boolean; platforms: readonly CodePlatformKind[] }) {
  const [days, setDays] = useState(30);
  const quality = useCached(`/findings/insights?days=${days}`, () =>
    api<Insights>(`/findings/insights?days=${days}`),
  );
  const runs = useCached(`/reviews?days=${days}`, () => api<Reviews>(`/reviews?days=${days}`));
  const series = useMemo(
    () => runs.data && daily(runs.data.reviews, runs.data.spend, days),
    [runs.data, days],
  );
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
          <Kpis runs={runs.data} quality={data} days={days} />
          <p className="muted small">
            Spend is what every model call made with your keys through ocra Cloud cost at list
            prices, from the provider's own token counts: reviews, replies, learnings, fixes, Ask
            ocra and failed calls alike. Calls the CLI makes with a key of its own are not included.
            {runs.data.unpricedCalls > 0 &&
              ` ${count(runs.data.unpricedCalls, "call")} on models without a price are not counted.`}{" "}
            <Link to="/usage">See it by day and model</Link>.
          </p>
          {runs.data.reviews.length < runs.data.summary.reviews && (
            <p className="muted small">
              The charts show the newest {num(runs.data.reviews.length)} of{" "}
              {num(runs.data.summary.reviews)} reviews.
            </p>
          )}
          <div className="chart-grid">
            <Charts
              daily={series}
              acceptance={data.byReviewer.flatMap((r) =>
                r.key && r.acceptanceRate !== null
                  ? [{ reviewer: r.key, rate: r.acceptanceRate, decided: r.fixed + r.dismissed }]
                  : [],
              )}
              reasons={data.dismissReasons.map((r) => ({
                reason: REASON[r.key ?? ""] ?? r.key ?? "No reason",
                n: r.n,
              }))}
            />
          </div>
          <SharedNote reported={runs.data.summary.findings} quality={data} />
          <Breakdown title="By reviewer" column="Reviewer" rows={data.byReviewer} none="(none)" />
          <Breakdown
            title="By severity"
            column="Severity"
            rows={data.bySeverity}
            none="(none)"
            name={sentence}
          />
          <Breakdown
            title="By verification"
            column="Verification"
            rows={data.byVerification}
            none="Not verified"
            name={sentence}
          />
          <Breakdown
            title="By category (top 20)"
            column="Category"
            rows={data.byCategory}
            none="No category"
          />
          <Breakdown
            title={`By rule (top ${MAX_RULE_ROWS})`}
            column="Rule or learning"
            rows={data.byRule}
            none="No rule named"
            name={ruleName}
            more={otherRules(data.otherRules)}
          />
        </>
      )}
      <ImpactSection days={days} quiet={runs.data?.summary.reviews === 0} />
      {props.runner && (
        <>
          <AtRiskSection />
          <FlowSection days={days} />
          <ReviewLoadSection days={days} />
        </>
      )}
      <Cycle days={days} platforms={props.platforms} />
    </>
  );
}

/**
 * The Findings figure counts what the period's reviews reported; the tables
 * count the shared findings, one per review that reported each, and their
 * Fixed counts a finding marked fixed in any way. Says so where they differ.
 */
function SharedNote(props: { reported: number; quality: Insights }) {
  const t = props.quality.total;
  if (t.total === 0) return null;
  const fewer = t.total < props.reported;
  return (
    <p className="muted small">
      {fewer
        ? `The tables count the ${num(t.total)} of the ${num(props.reported)} findings that were shared with ocra Cloud; the other reviews did not send theirs (sharing off on that machine, or past the account's limit). `
        : "The tables count the shared findings, one for each review that reported it. "}
      Their Fixed counts a finding marked fixed in any way, so it can differ from those fixed on a
      later review.
    </p>
  );
}

function Kpis(props: { runs: Reviews; quality: Insights; days: number }) {
  const s = props.runs.summary;
  const times = props.runs.reviews.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
  const median = quantile(times, 0.5);
  const t = props.quality.total;
  const spent = props.runs.spend.reduce((sum, d) => sum + d.usd, 0);
  const reviews = `/reviews?days=${props.days}`;
  return (
    <div className="stats stats-6">
      <Stat
        label="Reviews"
        value={num(s.reviews)}
        note={count(s.repositories, "repository", "repositories")}
        to={reviews}
      />
      <Stat
        label="Findings"
        value={num(s.findings)}
        note={count(s.blocking, "blocking review")}
        to="/findings?status=all"
      />
      <Stat
        label="Critical"
        value={num(s.critical)}
        note={`${num(s.fixed)} fixed on a later review`}
        to="/findings?status=all&severity=critical"
      />
      <Stat
        label="Accepted"
        value={rate(t.acceptanceRate)}
        note={`of ${num(t.fixed + t.dismissed)} decided${t.reacted > 0 ? ` · ${rate(t.thumbsUpRate)} upvoted` : ""}`}
        to="/findings?status=fixed"
      />
      <Stat
        label="Review time"
        value={median === null ? "–" : `${Math.round(median)}s`}
        note="median"
        to={reviews}
      />
      <Stat
        label="Spend"
        value={usd(spent)}
        note={s.reviews ? `${usd(s.costUsd / s.reviews)} a review` : "–"}
        to={reviews}
      />
    </div>
  );
}
