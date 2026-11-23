import { useState } from "react";
import type { AtRiskPullView, AtRiskView, ReviewTargetsView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { pullPath } from "../pull/path.js";
import { Link } from "../router.js";
import { LoadError, Loading } from "../ui.js";
import { span } from "./cycle.js";

// The open pull requests of the enrolled repositories that are near a
// review target or past it, the most overdue first.

const TARGET: Record<AtRiskPullView["target"], string> = {
  first_review: "First review",
  merge: "Merge",
};

function due(p: AtRiskPullView, now: number): string {
  const left = new Date(p.due).getTime() - now;
  return left < 0 ? `${span(-left)} overdue` : `due in ${span(left)}`;
}

export function AtRiskSection() {
  const [repo, setRepo] = useState("");
  const path = `/insights/at-risk${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
  const { data, error, reload } = useCached(path, () => api<AtRiskView>(path));
  const targets = useCached("/review-targets", () => api<ReviewTargetsView>("/review-targets"));
  const repos = targets.data?.repos ?? [];
  const now = Date.now();
  return (
    <section className="section card" aria-label="At risk">
      <div className="card-head">
        <h2>
          At risk <span className="subtle">open pull requests near or past a review target</span>
        </h2>
        {repos.length > 1 && (
          <select
            className="input at-risk-repo"
            aria-label="Repository at risk"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          >
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r.reviewRepoId} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && !data ? (
        <div className="card-pad">
          <LoadError what="the pull requests at risk" error={error} retry={reload} inCard />
        </div>
      ) : !data ? (
        <div className="card-pad">
          <Loading what="the pull requests at risk" />
        </div>
      ) : !data.targetsSet ? (
        <p className="card-pad subtle small m-0">
          No review target is set. <Link to="/auto-review">Set review targets</Link> on the Auto
          review page to see the pull requests that wait too long for a first review or a merge.
        </p>
      ) : data.pulls.length === 0 ? (
        <p className="card-pad subtle small m-0">
          No open pull request is near a target or past one.
        </p>
      ) : (
        <>
          {data.capped && (
            <p className="card-pad muted small m-0">
              More pull requests are open than one reading takes: these are from the oldest.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Target</th>
                  <th className="hide-narrow">Waiting on</th>
                  <th className="num">Due</th>
                </tr>
              </thead>
              <tbody>
                {data.pulls.map((p) => (
                  <tr key={`${p.platform}:${p.repo}#${p.number}:${p.target}`}>
                    <td className="text">
                      <Link to={pullPath(p.platform, p.repo, p.number)}>{p.title}</Link>
                      <div className="subtle small mono">
                        {p.repo} #{p.number}
                        {p.author && ` · ${p.author}`}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${p.state === "past" ? "badge-err" : "badge-warn"}`}>
                        {p.state === "past" ? "Past" : "Near"}
                      </span>{" "}
                      <span className="muted">{TARGET[p.target]}</span>
                    </td>
                    <td className="muted hide-narrow">
                      {p.waitingOn.length > 0 ? p.waitingOn.join(", ") : "–"}
                    </td>
                    <td className="num">{due(p, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
