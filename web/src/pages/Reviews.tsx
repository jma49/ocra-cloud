import { useState } from "react";
import { api, compact, num, type Review, type Reviews as ReviewsData, time } from "../api.js";
import { PageHead, Seg, useLoad } from "../ui.js";

const RANGES = [
  { value: 7, label: "1W" },
  { value: 30, label: "1M" },
  { value: 90, label: "3M" },
];

function Verdict(props: { r: Review }) {
  const { verdict, complete } = props.r;
  if (!complete)
    return (
      <span className="badge badge-warn" title="Some files were not reviewed">
        Incomplete
      </span>
    );
  if (verdict === "changes_requested")
    return <span className="badge badge-err">Changes requested</span>;
  if (verdict === "approved_with_comments") return <span className="badge">Comments</span>;
  if (verdict === "approved") return <span className="badge badge-ok">Approved</span>;
  return <span className="badge">–</span>;
}

export function Reviews() {
  const [days, setDays] = useState(30);
  const [data, error, reload] = useLoad(() => api<ReviewsData>(`/reviews?days=${days}`), [days]);
  const s = data?.summary;
  return (
    <>
      <PageHead
        title="Reviews"
        sub="Counts from each review the CLI ran while signed in. No code, paths or finding text are uploaded."
        actions={<Seg value={days} options={RANGES} onChange={setDays} />}
      />
      {error ? <p className="error">Could not load reviews.</p> : null}
      <div className="stats">
        <div className="card stat">
          <div className="stat-label">Reviews</div>
          <div className="stat-value">{s ? num(s.reviews) : "–"}</div>
          <div className="stat-note">{s ? `${num(s.repositories)} repositories` : " "}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Findings</div>
          <div className="stat-value">{s ? num(s.findings) : "–"}</div>
          <div className="stat-note">{s ? `${num(s.critical)} critical` : " "}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Changes requested</div>
          <div className="stat-value">{s ? num(s.changesRequested) : "–"}</div>
          <div className="stat-note">
            {s?.reviews ? `${Math.round((s.changesRequested / s.reviews) * 100)}% of reviews` : " "}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Tokens</div>
          <div className="stat-value">{s ? compact(s.tokensIn + s.tokensOut) : "–"}</div>
          <div className="stat-note">{s ? `${num(s.incomplete)} incomplete reviews` : " "}</div>
        </div>
      </div>
      <div className="section card">
        <div className="card-head">
          <h3>History</h3>
          <span className="subtle small">repositories are shown by an anonymous hash</span>
        </div>
        {data && data.reviews.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Repository</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th className="num">Critical</th>
                  <th className="num">Warning</th>
                  <th className="num">Suggestion</th>
                  <th className="num">Files</th>
                  <th className="num">Tokens</th>
                  <th className="num">Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{time(r.createdAt)}</td>
                    <td className="mono">{r.repo}</td>
                    <td className="muted">
                      {r.source === "local"
                        ? "Local"
                        : r.source === "github"
                          ? "GitHub PR"
                          : "GitLab MR"}
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
                    <td className="num">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Delete this record"
                        title="Delete this record"
                        onClick={async () => {
                          await api(`/reviews/${r.id}`, { method: "DELETE" }).catch(() => {});
                          reload();
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            No reviews yet. Sign in with <span className="mono">ocra login</span> and run{" "}
            <span className="mono">ocra review</span>.
          </div>
        )}
      </div>
    </>
  );
}
