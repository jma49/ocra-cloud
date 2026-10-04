import { api, type Key, type Usage } from "../api.js";
import { compact, num } from "../format.js";
import { Link } from "../router.js";
import { anyProvider } from "../site.js";
import { LoadError, Loading, PageHead, StackedBars, useLoad, useProviders } from "../ui.js";

export function Overview(props: { login: string }) {
  const {
    data: usage,
    error: usageError,
    reload: reloadUsage,
  } = useLoad(() => api<Usage>("/usage?days=14"));
  const { data: keys } = useLoad(() => api<{ keys: Key[] }>("/keys"));
  const providers = useProviders();
  const week = usage?.series.slice(-7) ?? [];
  const sum = (f: (d: Usage["series"][number]) => number) => week.reduce((n, d) => n + f(d), 0);
  const calls7 = sum((d) => d.calls);
  const errors7 = sum((d) => d.errors);
  const tokens7 = sum((d) => d.tokensIn + d.tokensOut);
  const pct = usage ? Math.min(100, (usage.today / usage.dailyLimit) * 100) : 0;
  const keyCount = keys?.keys.length ?? 0;
  const anyCalls = (usage?.series ?? []).some((d) => d.calls > 0);

  return (
    <>
      <PageHead
        title={`Welcome, ${props.login}`}
        sub="Your keys, your calls and your reviews in one place."
      />
      <div className="stats">
        <div className="card stat">
          <div className="stat-label">Requests today</div>
          <div className="stat-value">{usage ? num(usage.today) : "–"}</div>
          <div className="meter">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="stat-note">of {usage ? num(usage.dailyLimit) : "–"} a day</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Requests, 7 days</div>
          <div className="stat-value">{usage ? num(calls7) : "–"}</div>
          <div className="stat-note">
            {errors7 ? `${num(errors7)} failed upstream` : "no failures"}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Tokens, 7 days</div>
          <div className="stat-value">{usage ? compact(tokens7) : "–"}</div>
          <div className="stat-note">input and output</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Provider keys</div>
          <div className="stat-value">{keys ? keyCount : "–"}</div>
          <div className="stat-note">encrypted at rest</div>
        </div>
      </div>

      <div className="section">
        <div className="card">
          <div className="card-head">
            <h3>Requests, last 14 days</h3>
            <Link to="/activity" className="btn btn-sm">
              View activity
            </Link>
          </div>
          {usage && anyCalls ? (
            <StackedBars series={usage.series} metric="calls" />
          ) : usageError && !usage ? (
            <LoadError what="your requests" error={usageError} retry={reloadUsage} />
          ) : !usage ? (
            <Loading what="requests" />
          ) : (
            <div className="empty">
              No requests yet. They appear here once the CLI uses your keys.
            </div>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Get started</div>
        <div className="card steps">
          <Step n={1} done={keyCount > 0} title="Add a provider key">
            Bring your own key from {anyProvider(providers?.length)}.{" "}
            <Link to="/keys">Add a key</Link>
          </Step>
          <Step n={2} title="Install the CLI">
            <span className="cmd">npm install -g @open-cr-agent/cli</span>
          </Step>
          <Step n={3} title="Sign in from the terminal">
            <span className="cmd">ocra login</span>
          </Step>
          <Step n={4} done={anyCalls} title="Review a change">
            <span className="cmd">ocra review</span>
          </Step>
        </div>
      </div>
    </>
  );
}

function Step(props: { n: number; done?: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={`step${props.done ? " done" : ""}`}>
      <span className="step-n">{props.done ? "✓" : props.n}</span>
      <div>
        <div className="strong">{props.title}</div>
        <div className="muted small">{props.children}</div>
      </div>
    </div>
  );
}
