import { useState } from "react";
import { Status, type StatusTone } from "@/components/status";
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
import { ago } from "../format.js";
import { useAction, useLoad } from "../ui.js";
import { OUTCOME } from "./outcome.js";

// Merge when ready: the platform's own auto-merge, or this server merging
// it as the user once the platform, the pre-merge checks and ocra's review
// of the head allow it.

const STATE: Record<MergeIntentState, { text: string; tone: StatusTone }> = {
  armed: { text: "Armed", tone: "ok" },
  merging: { text: "Merging", tone: "ok" },
  merged: { text: "Merged", tone: "quiet" },
  closed: { text: "Closed unmerged", tone: "quiet" },
  disarmed: { text: "Stopped", tone: "warn" },
  cancelled: { text: "Cancelled", tone: "quiet" },
  failed: { text: "Stopped", tone: "err" },
};

const REASON: Record<MergeIntentReason, string> = {
  waiting_platform: "Waiting for required checks, approvals or a clean merge.",
  waiting_checks: "Waiting for the pre-merge checks.",
  checks_failed: "A blocking pre-merge check fails.",
  blocking_review: "ocra's review of this head has a critical finding.",
  head_moved: "The pull request gained commits.",
  refused: "The platform refused the merge.",
  no_token: "Connect the platform again.",
  unreachable: "The platform did not answer; it is tried again on its next event.",
};

const ANSWER: Record<MergeWhenReadyOutcome, string> = {
  ...OUTCOME,
  unavailable: "Auto-merge is off for this repository, and this server cannot stand in.",
  ready: "It can merge now: merge it directly.",
  merging: "A merge of it is under way.",
};

type Pull = { platform: string; repo: string; number: number };

export function MergeWhenReady(props: {
  pull: Pull;
  head: string;
  method: MergeMethod;
  label: Record<MergeMethod, string>;
}) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, reload } = useLoad(
    () => api<MergeWhenReadyView>(`/pulls/merge-when-ready?${q}`),
    [q.toString(), props.head],
  );
  const { method } = props;
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
    <section className="stack merge-when-ready" aria-label="Merge when ready">
      {intent && (
        <div className="row-gap checks-head">
          <span className="grow">Merge when ready</span>
          <Status tone={STATE[intent.state].tone}>{STATE[intent.state].text}</Status>
        </div>
      )}
      {live && (
        <span className="subtle small">
          {props.label[intent.method]}, set by {intent.armedBy} {ago(intent.armedAt)}
          {intent.keepOnPush ? ", kept on new commits" : ""}.
        </span>
      )}
      {intent?.reason && <span className="subtle small">{REASON[intent.reason]}</span>}
      {live ? (
        <Button type="button" variant="outline" loading={write.busy} onClick={() => send("DELETE")}>
          Cancel merge when ready
        </Button>
      ) : (
        <>
          <label className="check small">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep armed on new commits
          </label>
          <Button type="button" variant="outline" loading={write.busy} onClick={() => send("POST")}>
            Merge when ready
          </Button>
        </>
      )}
      {said && said !== "done" && (
        <p className="error small m-0" role="status">
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
