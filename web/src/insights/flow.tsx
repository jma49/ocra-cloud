import { FLOW_SIZES, type FlowSpread, type InsightsFlowView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { count, num } from "../format.js";
import { LoadError, Loading } from "../ui.js";
import { span } from "./cycle.js";

// How the enrolled repositories' pull requests moved toward review, from
// what their webhooks recorded since each was enrolled.

type Flow = InsightsFlowView;

const SIZE_LABEL: Record<keyof Flow["sizes"], string> = {
  xs: "Under 10 lines",
  s: "Under 100",
  m: "Under 500",
  l: "Under 1,000",
  xl: "1,000 and over",
  unknown: "Size not known",
};

export const week = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

const empty = (f: Flow) =>
  f.weeks.every((w) => w.opened === 0 && w.merged === 0) &&
  f.waiting.length === 0 &&
  f.reviewers.length === 0;

export function FlowSection(props: { days: number }) {
  const path = `/insights/flow?days=${props.days}`;
  const { data, error, reload } = useCached(path, () => api<Flow>(path));
  return (
    <section className="section card" aria-label="Review flow">
      <div className="card-head">
        <h2>
          Review flow <span className="subtle">in enrolled repositories, {props.days} days</span>
        </h2>
      </div>
      {error && !data ? (
        <div className="card-pad">
          <LoadError what="the review flow" error={error} retry={reload} />
        </div>
      ) : !data ? (
        <div className="card-pad">
          <Loading what="the review flow" />
        </div>
      ) : empty(data) ? (
        <p className="card-pad subtle small m-0">
          Nothing recorded in this period. The flow counts pull requests of repositories enrolled
          for auto review, from the day each was enrolled.
        </p>
      ) : (
        <FlowBody data={data} />
      )}
    </section>
  );
}

export function Figure(props: { label: string; spread: FlowSpread }) {
  return (
    <div className="cycle-figure">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{span(props.spread.median)}</div>
      <div className="stat-note">
        median · p90 {span(props.spread.p90)} · {count(props.spread.count, "pull request")}
      </div>
    </div>
  );
}

export function Bar(props: { n: number; of: number; tone: string; label: string }) {
  return (
    <span className="flow-bar">
      <span className="flow-track">
        <i
          className={props.tone}
          style={{ width: `${props.of ? (props.n / props.of) * 100 : 0}%` }}
        />
      </span>
      <span className="num">
        {num(props.n)} <span className="subtle">{props.label}</span>
      </span>
    </span>
  );
}

function FlowBody(props: { data: Flow }) {
  const { data } = props;
  const most = Math.max(1, ...data.weeks.flatMap((w) => [w.opened, w.merged]));
  const sized = [...FLOW_SIZES, "unknown" as const].filter((s) => data.sizes[s] > 0);
  const opened = sized.reduce((n, s) => n + data.sizes[s], 0);
  return (
    <>
      <div className="cycle-figures">
        <Figure label="To first review" spread={data.toFirstReview} />
        <Figure label="To first approval" spread={data.toFirstApproval} />
        <Figure label="Approval to merge" spread={data.approvalToMerge} />
      </div>
      {data.capped && (
        <p className="card-pad muted small m-0">
          This period held more pull requests than one reading counts: these are the newest.
        </p>
      )}
      <div className="flow-grid">
        <div>
          <div className="stat-label">Opened and merged, by week</div>
          <ul className="flow-rows">
            {data.weeks.map((w) => (
              <li key={w.start}>
                <span className="muted">{week(w.start)}</span>
                <Bar n={w.opened} of={most} tone="opened" label="opened" />
                <Bar n={w.merged} of={most} tone="merged" label="merged" />
              </li>
            ))}
          </ul>
        </div>
        {opened > 0 && (
          <div>
            <div className="stat-label">Opened, by size</div>
            <ul className="flow-rows sizes">
              {sized.map((s) => (
                <li key={s}>
                  <span className="muted">{SIZE_LABEL[s]}</span>
                  <Bar n={data.sizes[s]} of={opened} tone="opened" label="" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {data.waiting.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waiting longest for a first review</th>
                <th className="hide-narrow">Author</th>
                <th className="num">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {data.waiting.map((p) => (
                <tr key={`${p.repo}#${p.number}`}>
                  <td className="text">
                    {p.title}
                    <div className="subtle small mono">
                      {p.repo} #{p.number}
                      {!p.reviewRequested && " · no reviewer asked"}
                    </div>
                  </td>
                  <td className="muted hide-narrow">{p.author ?? "–"}</td>
                  <td className="num">{span(p.waitingMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.reviewers.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reviewer</th>
                <th className="num">Reviews</th>
                <th className="num">Approvals</th>
                <th className="num">Pull requests</th>
              </tr>
            </thead>
            <tbody>
              {data.reviewers.map((r) => (
                <tr key={r.login}>
                  <td>{r.login}</td>
                  <td className="num">{num(r.reviews)}</td>
                  <td className="num">{num(r.approvals)}</td>
                  <td className="num">{num(r.pulls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
