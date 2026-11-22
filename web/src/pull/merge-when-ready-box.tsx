import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  MergeIntentReason,
  MergeIntentState,
  MergeMethod,
  MergeWhenReadyAnswer,
  MergeWhenReadyOutcome,
  MergeWhenReadyView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction, useLoad } from "../ui.js";
import { OUTCOME } from "./outcome.js";

// Merge when ready: the platform's own auto-merge, or this server merging
// it as the user once the platform, the pre-merge checks and ocra's review
// of the head allow it.

const STATE: Record<MergeIntentState, string> = {
  armed: "Merges when ready",
  merging: "Merging",
  merged: "Merged",
  closed: "Closed before it merged",
  disarmed: "Stopped: new commits",
  cancelled: "Cancelled",
  failed: "Stopped",
};

const REASON: Record<MergeIntentReason, string> = {
  waiting_platform: "waiting for required checks, approvals or a clean merge",
  waiting_checks: "waiting for the pre-merge checks",
  checks_failed: "a blocking pre-merge check fails",
  blocking_review: "ocra's review of this head has a critical finding",
  head_moved: "the pull request gained commits",
  refused: "the platform refused the merge",
  no_token: "connect the platform again",
  unreachable: "the platform did not answer; it is tried again on its next event",
};

const ANSWER: Record<MergeWhenReadyOutcome, string> = {
  ...OUTCOME,
  unavailable: "Auto-merge is off for this repository, and this server cannot stand in.",
  ready: "It can merge now: merge it directly.",
  merging: "A merge of it is under way.",
};

type Pull = { platform: string; repo: string; number: number };

export function MergeWhenReadyBox(props: {
  pull: Pull;
  head: string;
  methods: MergeMethod[];
  label: Record<MergeMethod, string>;
}) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, reload } = useLoad(
    () => api<MergeWhenReadyView>(`/pulls/merge-when-ready?${q}`),
    [q.toString(), props.head],
  );
  const [method, setMethod] = useState<MergeMethod>(props.methods[0] ?? "merge");
  const [keep, setKeep] = useState(false);
  const [said, setSaid] = useState<MergeWhenReadyOutcome | null>(null);
  const write = useAction((verb: "POST" | "DELETE", body: unknown) =>
    api<MergeWhenReadyAnswer>("/pulls/merge-when-ready", {
      method: verb,
      body: JSON.stringify(body),
    }),
  );
  const send = async (verb: "POST" | "DELETE") => {
    const body =
      verb === "POST" ? { ...props.pull, method, head: props.head, keepOnPush: keep } : props.pull;
    const r = await write.run(verb, body);
    if (!r) return;
    setSaid(r.outcome);
    reload();
  };
  const intent = data?.intent;
  const live = intent && (intent.state === "armed" || intent.state === "merging");
  return (
    <section className="card card-pad stack" aria-label="Merge when ready">
      <div className="strong">Merge when ready</div>
      {intent && (
        <span>
          {STATE[intent.state]}
          {intent.reason && <span className="subtle"> · {REASON[intent.reason]}</span>}
        </span>
      )}
      {live ? (
        <Button variant="outline" disabled={write.busy} onClick={() => send("DELETE")}>
          Cancel merge when ready
        </Button>
      ) : (
        <>
          <select
            className="input"
            aria-label="Merge method when ready"
            value={method}
            onChange={(e) => setMethod(e.target.value as MergeMethod)}
          >
            {props.methods.map((m) => (
              <option key={m} value={m}>
                {props.label[m]}
              </option>
            ))}
          </select>
          <label className="check small">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep armed on new commits
          </label>
          <Button variant="outline" disabled={write.busy} onClick={() => send("POST")}>
            Merge when ready
          </Button>
        </>
      )}
      {said && said !== "done" && (
        <p className="error" role="status">
          {ANSWER[said]}
        </p>
      )}
      {write.error !== null && (
        <p className="error" role="alert">
          Could not change it: {why(write.error)}.
        </p>
      )}
    </section>
  );
}
