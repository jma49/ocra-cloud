import { Button } from "@/components/ui/button";
import { loadKeys } from "../account-keys.js";
import { api, type Me, type Usage } from "../api.js";
import { useCached } from "../cache.js";
import { GetStarted } from "../first-run/get-started.js";
import { compact, num } from "../format.js";
import { Link } from "../router.js";
import { EmptyNote, LoadError, Loading, PageHead, StackedBars, Stat, useLoad } from "../ui.js";

export function Overview(props: { me?: Me }) {
  const {
    data: usage,
    error: usageError,
    reload: reloadUsage,
  } = useCached("/usage?days=14", () => api<Usage>("/usage?days=14"));
  const { data: keys } = useLoad(loadKeys);
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
      <PageHead title="Usage" sub="Your keys, your calls and your reviews in one place." />
      <div className="stats">
        <Stat
          label="Requests today"
          value={usage ? num(usage.today) : "–"}
          note={`of ${usage ? num(usage.dailyLimit) : "–"} a day`}
          to="/activity?days=7"
        >
          <div className="meter">
            <span style={{ width: `${pct}%` }} />
          </div>
        </Stat>
        <Stat
          label="Requests, 7 days"
          value={usage ? num(calls7) : "–"}
          note={errors7 ? `${num(errors7)} failed upstream` : "no failures"}
          to="/activity?days=7"
        />
        <Stat
          label="Tokens, 7 days"
          value={usage ? compact(tokens7) : "–"}
          note="input and output"
          to="/activity?days=7"
        />
        <Stat
          label="Provider keys"
          value={keys ? keyCount : "–"}
          note="encrypted at rest"
          to="/keys"
        />
      </div>

      <div className="section">
        <div className="card">
          <div className="card-head">
            <h2>Requests, last 14 days</h2>
            <Button variant="outline" size="sm" render={<Link to="/activity" />}>
              View activity
            </Button>
          </div>
          {usage && anyCalls ? (
            <StackedBars series={usage.series} metric="calls" />
          ) : usageError && !usage ? (
            <LoadError what="your requests" error={usageError} retry={reloadUsage} inCard />
          ) : !usage ? (
            <Loading what="requests" inCard />
          ) : (
            <EmptyNote>No requests yet. They appear here once a review uses your keys.</EmptyNote>
          )}
        </div>
      </div>

      {props.me && <GetStarted me={props.me} />}
    </>
  );
}
