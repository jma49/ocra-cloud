import { useState } from "react";
import { api } from "../api.js";
import { num } from "../format.js";
import { LoadError, Loading, PageHead, Seg, useLoad } from "../ui.js";

// What the decisions in the findings inbox say about the reviews: of the
// findings someone marked fixed or dismissed, how many were right, per
// reviewer, severity, category and verification, and why the rest were
// dismissed. Only shared findings count.

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
  wrong_fix: "Suggested fix is wrong",
  already_known: "Already known",
};
const rate = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

function Breakdown(props: { title: string; rows: Row[]; none: string }) {
  if (props.rows.length === 0) return null;
  return (
    <div className="card">
      <h3>{props.title}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th className="num">Findings</th>
              <th className="num">Open</th>
              <th className="num">Fixed</th>
              <th className="num">Dismissed</th>
              <th className="num">Accepted</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.key ?? ""}>
                <td>{r.key ?? <span className="subtle">{props.none}</span>}</td>
                <td className="num">{num(r.total)}</td>
                <td className="num">{num(r.open)}</td>
                <td className="num">{num(r.fixed)}</td>
                <td className="num">{num(r.dismissed)}</td>
                <td className="num">{rate(r.acceptanceRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Insights() {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useLoad(
    () => api<Insights>(`/findings/insights?days=${days}`),
    [days],
  );
  return (
    <>
      <PageHead
        title="Review quality"
        sub="Accepted is fixed out of fixed plus dismissed: how often a finding someone decided on was right. Decide findings in Findings to fill it in."
        actions={
          <Seg
            label="Period"
            value={days}
            onChange={setDays}
            options={[
              { value: 7, label: "7 days" },
              { value: 30, label: "30 days" },
              { value: 90, label: "90 days" },
            ]}
          />
        }
      />
      {error && !data ? (
        <LoadError what="review quality" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="review quality" />
      ) : data.total.total === 0 ? (
        <div className="card empty-hero">
          <h3>No shared findings in this period</h3>
          <p>Turn on sharing in Settings; signed-in reviews then upload their findings.</p>
        </div>
      ) : (
        <>
          <div className="card">
            <p>
              {num(data.total.total)} findings, {num(data.total.open)} open, {num(data.total.fixed)}{" "}
              fixed, {num(data.total.dismissed)} dismissed. Accepted:{" "}
              {rate(data.total.acceptanceRate)}.
            </p>
            {data.dismissReasons.length > 0 && (
              <p className="muted">
                Dismissed because:{" "}
                {data.dismissReasons
                  .map((r) => `${REASON[r.key ?? ""] ?? r.key} ${num(r.n)}`)
                  .join(", ")}
              </p>
            )}
          </div>
          <Breakdown title="By reviewer" rows={data.byReviewer} none="(none)" />
          <Breakdown title="By severity" rows={data.bySeverity} none="(none)" />
          <Breakdown title="By verification" rows={data.byVerification} none="Not verified" />
          <Breakdown title="By category (top 20)" rows={data.byCategory} none="No category" />
        </>
      )}
    </>
  );
}
