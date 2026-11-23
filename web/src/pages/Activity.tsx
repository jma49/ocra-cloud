import { useState } from "react";
import { api, type Usage } from "../api.js";
import { useCached } from "../cache.js";
import { compact, num, period, time } from "../format.js";
import { PageHead, Seg, StackedBars } from "../ui.js";

const RANGES = [7, 14, 30, 90].map(period);

export function Activity() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"calls" | "tokens">("calls");
  const { data: usage, error } = useCached(`/usage?days=${days}`, () =>
    api<Usage>(`/usage?days=${days}`),
  );
  const total = usage?.series.reduce((n, d) => n + d.calls, 0) ?? 0;
  const tokens = usage?.series.reduce((n, d) => n + d.tokensIn + d.tokensOut, 0) ?? 0;
  const errors = usage?.series.reduce((n, d) => n + d.errors, 0) ?? 0;

  return (
    <>
      <PageHead
        title="Activity"
        sub="Every model call made with your keys. Request and answer bodies are never stored."
        actions={<Seg label="Time range" value={days} options={RANGES} onChange={setDays} />}
      />
      {error ? <p className="error">Could not load activity.</p> : null}
      <div className="stats stats-3">
        <div className="card stat">
          <div className="stat-label">Requests</div>
          <div className="stat-value">{usage ? num(total) : "–"}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Tokens</div>
          <div className="stat-value">{usage ? compact(tokens) : "–"}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Upstream errors</div>
          <div className="stat-value">{usage ? num(errors) : "–"}</div>
          <div className="stat-note">
            {total ? `${((errors / total) * 100).toFixed(1)}% of requests` : " "}
          </div>
        </div>
      </div>

      <div className="section card">
        <div className="card-head">
          <h2>By model</h2>
          <Seg
            label="Measure"
            value={metric}
            options={[
              { value: "calls", label: "Requests" },
              { value: "tokens", label: "Tokens" },
            ]}
            onChange={setMetric}
          />
        </div>
        {usage && total > 0 ? (
          <StackedBars series={usage.series} metric={metric} />
        ) : (
          <div className="empty">No requests in this range.</div>
        )}
      </div>

      {usage && usage.models.length > 0 && (
        <div className="section card">
          <div className="card-head">
            <h2>Models</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th className="num">Requests</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                </tr>
              </thead>
              <tbody>
                {usage.models.map((m) => (
                  <tr key={`${m.provider}/${m.model}`}>
                    <td className="mono">{m.model}</td>
                    <td className="muted">{m.provider}</td>
                    <td className="num">{num(m.calls)}</td>
                    <td className="num">{compact(m.tokensIn)}</td>
                    <td className="num">{compact(m.tokensOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section card">
        <div className="card-head">
          <h2>Recent requests</h2>
          {usage && usage.calls.length > 0 && (
            <span className="subtle small">latest {usage.calls.length}</span>
          )}
        </div>
        {usage && usage.calls.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th className="num">Tokens in</th>
                  <th className="num">Tokens out</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {usage.calls.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">{time(c.createdAt)}</td>
                    <td className="mono">{c.model ?? "–"}</td>
                    <td className="muted">{c.provider}</td>
                    <td>
                      {c.status === 0 ? (
                        <span className="badge">pending</span>
                      ) : (
                        <span className={`badge ${c.status < 400 ? "badge-ok" : "badge-err"}`}>
                          {c.status}
                        </span>
                      )}
                    </td>
                    <td className="num">{num(c.tokensIn)}</td>
                    <td className="num">{num(c.tokensOut)}</td>
                    <td className="num">{(c.ms / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No requests yet.</div>
        )}
      </div>
    </>
  );
}
