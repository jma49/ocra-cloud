import Wrench from "lucide-react/icons/wrench";
import { Button } from "@/components/ui/button";
import type { FixProposalView, PullActionOutcome } from "../../../src/shared/index.js";
import { BatchPick } from "../pull/batch.js";
import { OUTCOME } from "../pull/outcome.js";
import { SeverityBadge } from "../severity.js";
import { FixDiff } from "./fix-diff.js";
import { type CommitState, useCommitFix } from "./use-commit-fix.js";

/** What a commit of the fix came to, in a sentence; nothing before one is sent. */
export function CommitFixNote(props: { state: CommitState }) {
  const { state } = props;
  if (state === null || state === "sending") return null;
  if (state === "done") {
    return (
      <p className="note small m-0" role="status">
        The fix is committed to the pull request, and the finding is marked fixed.
      </p>
    );
  }
  return (
    <p className="error small m-0" role="alert">
      {state === "error" ? "Could not commit the fix; try again." : OUTCOME[state]}
    </p>
  );
}

/** ocra's fix of a finding on the pull request's diff, and its commit. */
export function FixProposal(props: {
  fix: FixProposalView;
  onDone: (outcome: PullActionOutcome) => void;
}) {
  const { fix } = props;
  const { state, commit } = useCommitFix(fix.finding, props.onDone);
  return (
    <section className="fix-proposal" aria-label={`ocra's fix: ${fix.title}`}>
      <div className="fix-proposal-head">
        <Wrench size={16} aria-hidden="true" />
        <span className="strong">ocra's fix</span>
        <SeverityBadge severity={fix.severity} />
        <span className="fix-proposal-title">{fix.title}</span>
        {state === "done" ? (
          <span className="badge badge-ok">Committed</span>
        ) : (
          <>
            <BatchPick pick={{ kind: "finding", id: fix.finding, label: fix.title }}>
              Commit with others
            </BatchPick>
            <Button size="sm" variant="outline" disabled={state === "sending"} onClick={commit}>
              Commit fix
            </Button>
          </>
        )}
      </div>
      <FixDiff fix={fix} />
      <CommitFixNote state={state} />
    </section>
  );
}
