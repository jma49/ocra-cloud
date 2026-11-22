import type { ReviewLoadView, ReviewLoadWeek } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { count, num } from "../format.js";
import { LoadError, Loading } from "../ui.js";
import { span } from "./cycle.js";

// Who carries the review work of the enrolled repositories: how fast a
// review asked of someone is answered, week by week, and each reviewer's
// reviews, asks and what still waits on them.

const week = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

const empty = (v: ReviewLoadView) =>
  v.reviewers.length === 0 &&
  v.weeks.every((w) => w.turnaround.count === 0 && w.waitingOver24h === 0);

export function ReviewLoadSection(props: { days: number }) {
  const path = `/insights/reviewers?days=${props.days}`;
  const { data, error, reload } = useCached(path, () => api<ReviewLoadView>(path));
  return (
    <section className="section card" aria-label="Reviewer workload">
      <div className="card-head">
        <h3>
          Reviewer workload{" "}
          <span className="subtle">in enrolled repositories, {props.days} days</span>
        </h3>
      </div>
      {error && !data ? (
        <div className="card-pad">
          <LoadError what="the reviewer workload" error={error} retry={reload} />
        </div>
      ) : !data ? (
        <div className="card-pad">
          <Loading what="the reviewer workload" />
        </div>
      ) : empty(data) ? (
        <p className="card-pad subtle small m-0">
          Nothing recorded in this period. The workload counts the review requests and reviews that
          enrolled repositories' webhooks record, so it starts empty and fills from there.
        </p>
      ) : (
        <>
          {data.capped && (
            <p className="card-pad muted small m-0">
              This period held more than one reading counts: these are the newest.
            </p>
          )}
          <Weeks weeks={data.weeks} />
          {data.reviewers.length > 0 && <Reviewers reviewers={data.reviewers} />}
        </>
      )}
    </section>
  );
}

function Weeks(props: { weeks: ReviewLoadWeek[] }) {
  const longest = Math.max(
    1,
    ...props.weeks.map((w) => w.turnaround.p90 ?? w.turnaround.median ?? 0),
  );
  const share = (ms: number | null) => `${((ms ?? 0) / longest) * 100}%`;
  return (
    <div className="load-weeks">
      <div className="stat-label">Request to first review, by week</div>
      <ul className="load-rows">
        {props.weeks.map((w) => (
          <li key={w.start}>
            <span className="muted">{week(w.start)}</span>
            <span className="load-track" aria-hidden="true">
              <i className="p90" style={{ width: share(w.turnaround.p90) }} />
              <i className="median" style={{ width: share(w.turnaround.median) }} />
            </span>
            <span className="num">
              {w.turnaround.count === 0 ? (
                <span className="subtle">No reviews</span>
              ) : (
                <>
                  {span(w.turnaround.median)}{" "}
                  <span className="subtle">
                    median · p90 {span(w.turnaround.p90)} · {count(w.turnaround.count, "review")}
                  </span>
                </>
              )}
            </span>
            <span className={w.waitingOver24h > 0 ? "num" : "num subtle"}>
              {num(w.waitingOver24h)} <span className="subtle">waited over a day</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reviewers(props: { reviewers: ReviewLoadView["reviewers"] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Reviewer</th>
            <th className="num">Reviews</th>
            <th className="num hide-narrow">Asked</th>
            <th className="num">To first review</th>
            <th className="num">Waiting now</th>
            <th className="num hide-narrow">Opened</th>
          </tr>
        </thead>
        <tbody>
          {props.reviewers.map((r) => (
            <tr key={r.login}>
              <td className="mono">{r.login}</td>
              <td className="num">{num(r.reviews)}</td>
              <td className="num hide-narrow">{num(r.asked)}</td>
              <td className="num">
                {span(r.toFirstReview.median)}
                {r.toFirstReview.p90 !== null && (
                  <span className="subtle"> · p90 {span(r.toFirstReview.p90)}</span>
                )}
              </td>
              <td className={r.openRequests > 0 ? "num strong" : "num subtle"}>
                {num(r.openRequests)}
              </td>
              <td className="num hide-narrow">{num(r.authored)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
