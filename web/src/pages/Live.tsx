import type { LucideIcon } from "lucide-react";
import Radio from "lucide-react/icons/radio";
import Users from "lucide-react/icons/users";
import type { LiveRunView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ago, sourceLabel, usd } from "../format.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead, useLoad } from "../ui.js";

// Reviews relayed while they run: the account's own, and the ones others
// shared with it.

type LiveList = { runs: LiveRunView[]; shared: LiveRunView[] };

const STATE = {
  running: { label: "Running", cls: "badge-run" },
  finished: { label: "Finished", cls: "badge-ok" },
  failed: { label: "Stopped", cls: "badge-err" },
} as const;

export function Live() {
  const list = useLoad(() => api<LiveList>("/live"));
  return (
    <>
      <PageHead
        title="Live"
        sub="Reviews as they run. Share one to watch it and talk about its findings together."
      />
      {list.error && !list.data ? (
        <LoadError what="live reviews" error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <Loading what="live reviews" />
      ) : (
        <>
          <Runs
            title="Your runs"
            runs={list.data.runs}
            empty={{
              icon: Radio,
              title: "No live runs yet",
              text: "A review appears here while it runs when your account shares findings (Settings). Run ocra review signed in, and its address is printed at the start.",
            }}
          />
          <Runs
            title="Shared with you"
            runs={list.data.shared}
            empty={{
              icon: Users,
              title: "Nothing shared with you",
              text: "Runs others share with you by name appear here.",
            }}
          />
        </>
      )}
    </>
  );
}

function Runs(props: {
  title: string;
  runs: LiveRunView[];
  empty: { icon: LucideIcon; title: string; text: string };
}) {
  return (
    <div className="card section">
      <div className="card-head">
        <h2>{props.title}</h2>
      </div>
      {props.runs.length === 0 ? (
        <EmptyState icon={props.empty.icon} title={props.empty.title}>
          {props.empty.text}
        </EmptyState>
      ) : (
        <ul className="live-list">
          {props.runs.map((r) => {
            const state = STATE[r.state];
            return (
              <li key={r.id}>
                <Link className="list-row" to={`/live/${r.id}`}>
                  <span className={`badge ${state.cls}`}>{state.label}</span>
                  <span className="grow stack-tight">
                    <span className="strong">{r.target || "Review"}</span>
                    <span className="subtle small">
                      {[r.repo, r.prNumber ? `#${r.prNumber}` : null, sourceLabel(r.source)]
                        .filter(Boolean)
                        .join(" · ")}
                      {r.access !== "owner" ? ` · from ${r.owner}` : ""}
                    </span>
                  </span>
                  <span className="num subtle hide-narrow">{usd(r.costUsd)}</span>
                  <span className="subtle small">{ago(r.updatedAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
