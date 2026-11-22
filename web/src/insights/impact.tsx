import type { ImpactCounts, InsightsImpactView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { count, num } from "../format.js";
import { LoadError, Loading } from "../ui.js";
import { Bar, Figure, week } from "./flow.js";

// What ocra's reviews changed in the repositories it reviewed: how much it
// reviewed, what it found and what became of that, and whether reviewed
// pull requests merged sooner. Only enrolled repositories know what was
// opened and merged, so the shares and merge times show for those alone.

type Impact = InsightsImpactView;

const SEVERITIES = [
  { key: "critical", label: "Critical", tone: "critical" },
  { key: "warning", label: "Warning", tone: "warning" },
  { key: "suggestion", label: "Suggestion", tone: "opened" },
] as const;

type Via = NonNullable<ImpactCounts["actedOn"]>["fixedVia"];
const VIA: [keyof Via, string][] = [
  ["applied", "by committing ocra's fix"],
  ["suggestion", "by a suggestion"],
  ["manual", "by hand"],
  ["rereview", "by a later review"],
  ["unknown", "before this was recorded"],
];
/** " (3 by hand, 1 by a suggestion)", or nothing when none is fixed. */
function how(via: Via): string {
  const parts = VIA.flatMap(([k, label]) => (via[k] > 0 ? [`${num(via[k])} ${label}`] : []));
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

const found = (c: ImpactCounts) => c.findings.critical + c.findings.warning + c.findings.suggestion;
const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

export function ImpactSection(props: { days: number }) {
  const path = `/insights/impact?days=${props.days}`;
  const { data, error, reload } = useCached(path, () => api<Impact>(path));
  return (
    <section className="section card" aria-label="What ocra changed">
      <div className="card-head">
        <h3>
          What ocra changed{" "}
          <span className="subtle">in the repositories it reviewed, {props.days} days</span>
        </h3>
      </div>
      {error && !data ? (
        <div className="card-pad">
          <LoadError what="what ocra changed" error={error} retry={reload} />
        </div>
      ) : !data ? (
        <div className="card-pad">
          <Loading what="what ocra changed" />
        </div>
      ) : data.total.pulls === 0 && data.total.reviews === 0 ? (
        <p className="card-pad subtle small m-0">
          Nothing recorded in this period. This counts ocra's reviews of pull requests, uploaded by
          the CLI or made by auto review.
        </p>
      ) : (
        <ImpactBody data={data} />
      )}
    </section>
  );
}

function Stat(props: { label: string; value: string; note: string }) {
  return (
    <div className="cycle-figure">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      <div className="stat-note">{props.note}</div>
    </div>
  );
}

function ImpactBody(props: { data: Impact }) {
  const { data } = props;
  const t = data.total;
  const findings = found(t);
  const most = Math.max(1, ...data.weeks.map((w) => w.pulls));
  const merge = data.toMerge;
  return (
    <>
      <div className="cycle-figures">
        {merge ? (
          <Stat
            label="Pull requests reviewed"
            value={share(t.reviewedPulls, t.pulls)}
            note={`${num(t.reviewedPulls)} of ${num(t.pulls)} opened · ${count(t.reviews, "review")}`}
          />
        ) : (
          <Stat
            label="Pull requests reviewed"
            value={num(t.reviewedPulls)}
            note={count(t.reviews, "review")}
          />
        )}
        <Stat
          label="Findings"
          value={num(findings)}
          note={`${num(t.findings.critical)} critical · ${num(t.findings.warning)} warning`}
        />
        <Stat
          label="Fixed in the code"
          value={num(t.fixedOnRereview)}
          note={`not found again on a later review · ${num(t.dismissedOnRereview)} dismissed by a reviewer`}
        />
      </div>
      {merge && merge.reviewed.count > 0 && merge.unreviewed.count > 0 && (
        <div className="cycle-figures">
          <Figure label="Opened to merge, reviewed by ocra" spread={merge.reviewed} />
          <Figure label="Opened to merge, not reviewed" spread={merge.unreviewed} />
          <Figure label="First ocra review to merge" spread={merge.fromReview} />
        </div>
      )}
      {data.capped && (
        <p className="card-pad muted small m-0">
          This period held more than one reading counts: these are the newest.
        </p>
      )}
      <div className="flow-grid">
        <div>
          <div className="stat-label">
            {merge ? "Opened and reviewed, by week" : "Reviewed, by week"}
          </div>
          <ul className={merge ? "flow-rows" : "flow-rows sizes"}>
            {data.weeks.map((w) => (
              <li key={w.start}>
                <span className="muted">{week(w.start)}</span>
                {merge && <Bar n={w.pulls} of={most} tone="opened" label="opened" />}
                <Bar n={w.reviewedPulls} of={most} tone="merged" label="reviewed" />
              </li>
            ))}
          </ul>
        </div>
        {findings > 0 && (
          <div>
            <div className="stat-label">Findings, by severity</div>
            <ul className="flow-rows sizes">
              {SEVERITIES.map((s) => (
                <li key={s.key}>
                  <span className="muted">{s.label}</span>
                  <Bar n={t.findings[s.key]} of={findings} tone={s.tone} label="" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="card-pad subtle small m-0">
        {t.actedOn
          ? `In the console: ${num(t.actedOn.fixed)} marked fixed${how(t.actedOn.fixedVia)}, ${num(t.actedOn.dismissed)} dismissed, ${num(t.actedOn.open)} open, ${count(t.actedOn.issueOpened, "issue")} opened from a finding, ${count(t.actedOn.threadResolved, "thread")} resolved.`
          : "Share findings in Settings to count what was marked fixed or dismissed in the console."}
      </p>
      {data.repos.length > 1 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th className="num">Opened</th>
                <th className="num">Reviewed</th>
                <th className="num">Findings</th>
                <th className="num hide-narrow">Fixed</th>
              </tr>
            </thead>
            <tbody>
              {data.repos.map((r) => (
                <tr key={`${r.repo}:${r.enrolled}`}>
                  <td className="mono">{r.repo}</td>
                  <td className="num">{r.enrolled ? num(r.pulls) : "–"}</td>
                  <td className="num">
                    {r.enrolled ? share(r.reviewedPulls, r.pulls) : num(r.reviewedPulls)}
                  </td>
                  <td className="num">{num(found(r))}</td>
                  <td className="num hide-narrow">{num(r.fixedOnRereview)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
