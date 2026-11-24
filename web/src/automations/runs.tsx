import { Status, type StatusTone } from "@/components/status";
import type { AutomationActionOutcome, AutomationRunView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { EmptyNote } from "../ui.js";
import { ACTION_LABEL, OUTCOME_LABEL, RUN_LABEL, SKIP_LABEL } from "./describe.js";

// The rules' recent runs, newest first: which pull request, and how each
// action went.

// Skips this server is expected to make, which the page explains, are not errors.
const QUIET = new Set<AutomationActionOutcome>([
  "done",
  "needs_self_hosted",
  "not_enrolled",
  "enough_reviewers",
  "already_assigned",
]);

/** Nothing broke, but the rule's owner has something to change. */
const WARN = new Set<AutomationActionOutcome>(["no_candidates"]);
const tone = (o: AutomationActionOutcome) =>
  QUIET.has(o) ? "muted" : WARN.has(o) ? "warn-inline" : "error-inline";

const RUN_TONE: Record<AutomationRunView["outcome"], StatusTone> = {
  running: "run",
  done: "ok",
  partial: "warn",
  failed: "err",
  skipped: "quiet",
};

export function Runs(props: { runs: AutomationRunView[] }) {
  if (props.runs.length === 0)
    return (
      <EmptyNote>
        No rule has run yet. Each time one acts on a pull request, it is listed here.
      </EmptyNote>
    );
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
                <Status tone={RUN_TONE[r.outcome]}>{RUN_LABEL[r.outcome]}</Status>
              </td>
              <td>{r.pull}</td>
              <td className="text">
                {r.reason && <span className="muted">{SKIP_LABEL[r.reason]}</span>}
                {r.retryAt && <span className="muted">Will retry</span>}
                <ul className="run-actions">
                  {r.actions.map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a run's actions are stored once, in the rule's order.
                    <li key={`${a.kind}-${i}`}>
                      {ACTION_LABEL[a.kind]}
                      {": "}
                      <span className={tone(a.outcome)}>{OUTCOME_LABEL[a.outcome]}</span>
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
