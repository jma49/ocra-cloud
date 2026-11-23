import GitPullRequest from "lucide-react/icons/git-pull-request";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, type Review, type Reviews as ReviewsData, why } from "../api.js";
import { useCached } from "../cache.js";
import { compact, count, num, period, since, sourceLabel, time } from "../format.js";
import { CloseGlyph } from "../glyphs.js";
import { Link } from "../router.js";
import { EmptyState, Loading, PageHead, Seg, useAction } from "../ui.js";

const RANGES = [7, 30, 90].map(period);

function Verdict(props: { r: Review }) {
  const { verdict, complete } = props.r;
  if (!complete)
    return (
      <span className="badge badge-warn" title="Some files were not reviewed">
        Incomplete
      </span>
    );
  if (verdict === "significant_concerns")
    return <span className="badge badge-err">Significant concerns</span>;
  if (verdict === "minor_issues") return <span className="badge badge-warn">Minor issues</span>;
  if (verdict === "approved_with_comments") return <span className="badge">Comments</span>;
  if (verdict === "approved") return <span className="badge badge-ok">Approved</span>;
  return <span className="badge">–</span>;
}

/** What a review was of, as its link: the pull request where it had one, then how it ran. */
function ReviewOf(props: { r: Review }) {
  const { r } = props;
  const repo = r.name ?? r.repo;
  return (
    <div className="review-of">
      <Link to={`/reviews/${r.id}`}>
        <span className="mono">{repo}</span>
        {r.prNumber != null && <span className="review-of-num"> #{r.prNumber}</span>}
      </Link>
      <span className="subtle small">
        {sourceLabel(r.source)}
        {r.prHeadSha && <span className="mono"> {r.prHeadSha.slice(0, 7)}</span>}
      </span>
    </div>
  );
}

export function Reviews(props: {
  /** Whether this server runs reviews itself, so one need not come from the CLI. */
  runner?: boolean;
}) {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useCached(`/reviews?days=${days}`, () =>
    api<ReviewsData>(`/reviews?days=${days}`),
  );
  const del = useAction((id: string) => api(`/reviews/${id}`, { method: "DELETE" }));
  const remove = async (id: string) => {
    if ((await del.run(id)) !== undefined) reload();
  };
  const failed = del.error ? `Could not delete the record: ${why(del.error)}.` : "";
  const s = data?.summary;
  return (
    <>
      <PageHead
        title="Reviews"
        sub={
          props.runner
            ? "Each review ocra ran on a pull request here, or from the CLI while signed in: its counts, and its findings."
            : "Each review the CLI ran while signed in: its counts, and its findings when you share them in Settings."
        }
        actions={<Seg label="Time range" value={days} options={RANGES} onChange={setDays} />}
      />
      {error ? <p className="error">Could not load reviews: {why(error)}.</p> : null}
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      <div className="stats">
        <div className="card stat">
          <div className="stat-label">Reviews</div>
          <div className="stat-value">{s ? num(s.reviews) : "–"}</div>
          <div className="stat-note">
            {s ? count(s.repositories, "repository", "repositories") : " "}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Findings</div>
          <div className="stat-value">{s ? num(s.findings) : "–"}</div>
          <div className="stat-note">{s ? `${num(s.critical)} critical` : " "}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Significant concerns</div>
          <div className="stat-value">{s ? num(s.blocking) : "–"}</div>
          <div className="stat-note">
            {s?.reviews ? `${Math.round((s.blocking / s.reviews) * 100)}% of reviews` : " "}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Tokens</div>
          <div className="stat-value">{s ? compact(s.tokensIn + s.tokensOut) : "–"}</div>
          <div className="stat-note">{s ? count(s.incomplete, "incomplete review") : " "}</div>
        </div>
      </div>
      {data && Object.keys(data.reviewers).length > 0 && (
        <div className="section card">
          <div className="card-head">
            <h3>By reviewer</h3>
            <span className="subtle small">
              Acceptance: findings later fixed, over fixed and dismissed
              {s && s.fixed + s.dismissed > 0
                ? ` · overall ${Math.round((s.fixed / (s.fixed + s.dismissed)) * 100)}%`
                : ""}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th className="num">Tasks</th>
                  <th className="num">Failed</th>
                  <th className="num">Findings</th>
                  <th className="num">Critical</th>
                  <th className="num">Fixed</th>
                  <th className="num">Dismissed</th>
                  <th className="num">Acceptance</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.reviewers)
                  .sort((a, b) => b[1].findingsTotal - a[1].findingsTotal)
                  .map(([id, r]) => (
                    <tr key={id}>
                      <td className="mono">{id}</td>
                      <td className="num">{num(r.tasks)}</td>
                      <td className="num">
                        {r.failedTasks ? <span className="error">{r.failedTasks}</span> : 0}
                      </td>
                      <td className="num">{num(r.findingsTotal)}</td>
                      <td className="num">{r.findings.critical}</td>
                      <td className="num">{r.fixed}</td>
                      <td className="num">{r.dismissed}</td>
                      <td className="num">
                        {r.acceptanceRate === null ? "–" : `${Math.round(r.acceptanceRate * 100)}%`}
                      </td>
                      <td className="num">${r.costUsd.toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section card">
        <div className="card-head">
          <h3>History</h3>
          <span className="subtle small">
            Repositories are shown by an anonymous hash until you name them under Repositories
          </span>
        </div>
        {!data ? (
          <Loading what="reviews" />
        ) : data.reviews.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Review</th>
                  <th>Result</th>
                  <th className="num">Critical</th>
                  <th className="num">Warning</th>
                  <th className="num">Suggestion</th>
                  <th className="num">Files</th>
                  <th className="num">Tokens</th>
                  <th className="num">Duration</th>
                  <th className="num">When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <ReviewOf r={r} />
                    </td>
                    <td>
                      <Verdict r={r} />
                    </td>
                    <td className="num">{r.critical}</td>
                    <td className="num">{r.warning}</td>
                    <td className="num">{r.suggestion}</td>
                    <td className="num" title={`${r.filesNotReviewed} not reviewed`}>
                      {r.filesReviewed}
                      {r.filesNotReviewed ? (
                        <span className="subtle">/{r.filesReviewed + r.filesNotReviewed}</span>
                      ) : null}
                    </td>
                    <td className="num">{compact(r.tokensIn + r.tokensOut)}</td>
                    <td className="num">{(r.durationMs / 1000).toFixed(0)}s</td>
                    <td className="num subtle">
                      <time dateTime={r.createdAt} title={time(r.createdAt)}>
                        {since(r.createdAt)}
                      </time>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Delete this record"
                        title="Delete this record"
                        onClick={() => remove(r.id)}
                      >
                        <CloseGlyph size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={GitPullRequest}
            title={`No reviews in the last ${days} days`}
            action={
              props.runner && (
                <Button variant="outline" render={<Link to="/auto-review" />}>
                  Set up auto review
                </Button>
              )
            }
          >
            {props.runner
              ? "Turn on auto review for a repository and ocra reviews each of its pull requests. From the CLI, sign in with "
              : "Sign in with "}
            <span className="mono">ocra login</span> and run{" "}
            <span className="mono">ocra review</span>.
          </EmptyState>
        )}
      </div>
    </>
  );
}
