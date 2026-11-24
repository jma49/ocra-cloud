import { useState } from "react";
import { Status } from "@/components/status";
import { api, type Usage } from "../api.js";
import { useCached } from "../cache.js";
import { compact, num, period, time } from "../format.js";
import { daysParam } from "../router.js";
import { StackTable } from "../stack-table.js";
import { EmptyNote, LoadError, Loading, PageHead, Seg, StackedBars } from "../ui.js";
import { SpendLedger } from "../usage/spend-ledger.js";

const RANGES = [7, 14, 30, 90].map(period);

export function Activity() {
  const [days, setDays] = useState(() => daysParam(RANGES, 30));
  const [metric, setMetric] = useState<"calls" | "tokens">("calls");
  const {
    data: usage,
    error,
    reload,
  } = useCached(`/usage?days=${days}`, () => api<Usage>(`/usage?days=${days}`));
  return (
    <>
      <PageHead
        title="Activity"
        sub="Every model call made with your keys."
        note="Request and answer bodies are never stored."
        actions={<Seg label="Time range" value={days} options={RANGES} onChange={setDays} />}
      />
      {error && !usage ? (
        <LoadError what="activity" error={error} retry={reload} />
      ) : (
        <ActivityBody usage={usage} metric={metric} setMetric={setMetric} />
      )}
    </>
  );
}

function ActivityBody(props: {
  usage: Usage | undefined;
  metric: "calls" | "tokens";
  setMetric: (m: "calls" | "tokens") => void;
}) {
  const { usage, metric, setMetric } = props;
  const total = usage?.series.reduce((n, d) => n + d.calls, 0) ?? 0;
  const tokens = usage?.series.reduce((n, d) => n + d.tokensIn + d.tokensOut, 0) ?? 0;
  const errors = usage?.series.reduce((n, d) => n + d.errors, 0) ?? 0;
  return (
    <>
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
        {!usage ? (
          <Loading what="requests by model" inCard />
        ) : total > 0 ? (
          <StackedBars series={usage.series} metric={metric} />
        ) : (
          <EmptyNote>No requests in this range</EmptyNote>
        )}
      </div>

      {usage && usage.models.length > 0 && (
        <div className="section card">
          <div className="card-head">
            <h2>Models</h2>
          </div>
          <StackTable>
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
                    <td>{m.model}</td>
                    <td className="muted">{m.provider}</td>
                    <td className="num">
                      <span className="cell-name" aria-hidden="true">
                        Requests
                      </span>
                      {num(m.calls)}
                    </td>
                    <td className="num">
                      <span className="cell-name" aria-hidden="true">
                        Input
                      </span>
                      {compact(m.tokensIn)}
                    </td>
                    <td className="num">
                      <span className="cell-name" aria-hidden="true">
                        Output
                      </span>
                      {compact(m.tokensOut)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
        </div>
      )}

      <SpendLedger />

      <div className="section card">
        <div className="card-head">
          <h2>Recent requests</h2>
          {usage && usage.calls.length > 0 && (
            <span className="subtle small">latest {usage.calls.length}</span>
          )}
        </div>
        {!usage ? (
          <Loading what="recent requests" inCard />
        ) : usage.calls.length > 0 ? (
          <StackTable>
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
                    <td>{c.model ?? "–"}</td>
                    <td className="muted">{c.provider}</td>
                    <td>
                      {c.status === 0 ? (
                        <Status tone="quiet">Pending</Status>
                      ) : (
                        <Status tone={c.status < 400 ? "ok" : "err"}>{c.status}</Status>
                      )}
                    </td>
                    <td className="num">
                      <span className="cell-name" aria-hidden="true">
                        In
                      </span>
                      {num(c.tokensIn)}
                    </td>
                    <td className="num">
                      <span className="cell-name" aria-hidden="true">
                        Out
                      </span>
                      {num(c.tokensOut)}
                    </td>
                    <td className="num">{(c.ms / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
        ) : (
          <EmptyNote>
            No requests yet. Each model call a review makes with your keys is listed here.
          </EmptyNote>
        )}
      </div>
    </>
  );
}
