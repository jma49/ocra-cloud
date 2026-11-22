import { useState } from "react";
import type { CodePlatformKind, CycleView, Spread } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { useCached } from "../cache.js";
import { date, num } from "../format.js";
import { Link } from "../router.js";
import { LoadError, Loading, Seg } from "../ui.js";

// How long the user's own merged pull requests took, read live from the
// platform: opened to first review by someone else, and to merged.

const HOUR = 3_600_000;

/** A duration in the unit a person reads it in: minutes, hours or days. */
export function span(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)}h`;
  return `${(ms / (24 * HOUR)).toFixed(1)}d`;
}

const SLOWEST = 8;

export function Cycle(props: { days: number }) {
  const [platform, setPlatform] = useState<CodePlatformKind>("github");
  const path = `/insights/cycle?platform=${platform}&days=${props.days}`;
  const { data, error, reload } = useCached(path, () => api<CycleView>(path));
  const unlinked = error instanceof ApiError && error.code === "github_user";
  return (
    <section className="section card" aria-label="Pull request cycle">
      <div className="card-head">
        <h3>
          Your pull requests <span className="subtle">merged in {props.days} days</span>
        </h3>
        <Seg
          label="Platform"
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "github", label: "GitHub" },
            { value: "gitlab", label: "GitLab" },
          ]}
        />
      </div>
      {unlinked ? (
        <p className="card-pad subtle small m-0">
          Connect {platform === "github" ? "GitHub" : "GitLab"} in{" "}
          <Link to="/repositories">Repositories</Link> to time your pull requests.
        </p>
      ) : error && !data ? (
        <div className="card-pad">
          <LoadError what="your pull requests" error={error} retry={reload} />
        </div>
      ) : !data ? (
        <div className="card-pad">
          <Loading what="your pull requests" />
        </div>
      ) : data.pulls.length === 0 ? (
        <p className="card-pad subtle small m-0">
          No pull requests of yours merged in this period.
        </p>
      ) : (
        <CycleBody data={data} />
      )}
    </section>
  );
}

function Figure(props: { label: string; spread: Spread }) {
  return (
    <div className="cycle-figure">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{span(props.spread.median)}</div>
      <div className="stat-note">median · p90 {span(props.spread.p90)}</div>
    </div>
  );
}

function CycleBody(props: { data: CycleView }) {
  const { data } = props;
  const slowest = [...data.pulls].sort((a, b) => b.toMergeMs - a.toMergeMs).slice(0, SLOWEST);
  return (
    <>
      <div className="cycle-figures">
        <div className="cycle-figure">
          <div className="stat-label">Merged</div>
          <div className="stat-value">
            {num(data.pulls.length)}
            {data.capped && "+"}
          </div>
          <div className="stat-note">{num(data.unreviewed)} without anyone's review</div>
        </div>
        <Figure label="To first review" spread={data.toFirstReview} />
        <Figure label="To merge" spread={data.toMerge} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Slowest to merge</th>
              <th className="hide-narrow">Merged</th>
              <th className="num">First review</th>
              <th className="num">Merge</th>
            </tr>
          </thead>
          <tbody>
            {slowest.map((p) => (
              <tr key={`${p.repo}#${p.number}`}>
                <td className="text">
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                  <div className="subtle small mono">
                    {p.repo} #{p.number}
                  </div>
                </td>
                <td className="muted hide-narrow">{date(p.mergedAt)}</td>
                <td className="num">{span(p.toFirstReviewMs)}</td>
                <td className="num">{span(p.toMergeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
