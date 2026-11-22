import type { AutomationActionOutcome, AutomationRunView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { ACTION_LABEL, OUTCOME_LABEL, RUN_LABEL } from "./describe.js";

// The rules' recent runs, newest first: which pull request, and how each
// action went.

// Skips this server is expected to make, which the page explains, are not errors.
const QUIET = new Set<AutomationActionOutcome>(["done", "needs_self_hosted", "not_enrolled"]);

const RUN_TONE: Record<AutomationRunView["outcome"], string> = {
  running: "badge",
  done: "badge badge-ok",
  partial: "badge badge-warn",
  failed: "badge badge-err",
};

export function Runs(props: { runs: AutomationRunView[] }) {
  if (props.runs.length === 0)
    return <p className="subtle small card-pad m-0">No rule has run yet.</p>;
  return (
    <div className="table-wrap stack">
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>Pull request</th>
            <th>Actions</th>
            <th className="hide-narrow">When</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((r) => (
            <tr key={r.id}>
              <td className="text">
                <div className="strong">{r.ruleName}</div>
                <span className={RUN_TONE[r.outcome]}>{RUN_LABEL[r.outcome]}</span>
              </td>
              <td className="mono">{r.pull}</td>
              <td className="text">
                <ul className="run-actions">
                  {r.actions.map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a run's actions are stored once, in the rule's order.
                    <li key={`${a.kind}-${i}`}>
                      {ACTION_LABEL[a.kind]}
                      {": "}
                      <span className={QUIET.has(a.outcome) ? "muted" : "error-inline"}>
                        {OUTCOME_LABEL[a.outcome]}
                      </span>
                    </li>
                  ))}
                </ul>
              </td>
              <td className="muted hide-narrow">{ago(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
