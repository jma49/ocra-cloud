import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DismissReason, FindingStatus, PullFindingView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { DISMISS_REASONS } from "../dismiss-reasons.js";
import { useToast } from "../toast.js";

type Answer = { changed: number; remembered: number; memoryFull?: boolean };

/**
 * Marks a finding on the diff fixed or dismisses it, in place: a dismissal
 * asks why on the same line, with no dialog. The note leaves the diff at
 * once (`onDecided`), and comes back if the server refuses or on Undo.
 */
export function FindingDecide(props: {
  finding: PullFindingView;
  onDecided: (decided: boolean) => void;
}) {
  const { finding: f } = props;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<DismissReason>("false_positive");
  const [remember, setRemember] = useState(false);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const send = async (status: FindingStatus) => {
    const body =
      status === "dismissed" ? { ids: [f.id], status, reason, remember } : { ids: [f.id], status };
    // The note leaves at once and this control with it: what follows speaks in toasts.
    props.onDecided(status !== "open");
    setBusy(true);
    let answer: Answer;
    try {
      answer = await api<Answer>("/findings/decide", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      props.onDecided(status === "open");
      toast(`Could not decide on the finding: ${why(e)}`, "error");
      return;
    } finally {
      setBusy(false);
    }
    if (status === "open") return;
    const kept = answer.remembered > 0 ? "; its repository's next review will not report it" : "";
    const full = answer.memoryFull ? "; the repository's memory is full, so it was not kept" : "";
    toast(
      `${status === "fixed" ? "Marked fixed" : "Dismissed"}: ${f.title}${kept}${full}`,
      "success",
      // A remembered dismissal stays remembered, so only the rest undo.
      answer.remembered > 0 ? undefined : { label: "Undo", run: () => void send("open") },
    );
  };

  if (!asking) {
    return (
      <div className="finding-decide">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send("fixed")}>
          Mark fixed
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking(true)}>
          Dismiss
        </Button>
      </div>
    );
  }
  return (
    <form
      className="finding-decide"
      onSubmit={(e) => {
        e.preventDefault();
        void send("dismissed");
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setAsking(false);
      }}
    >
      <select
        className="input"
        aria-label="Why dismiss it"
        value={reason}
        // biome-ignore lint/a11y/noAutofocus: the reason is the one question this step asks
        autoFocus
        onChange={(e) => setReason(e.target.value as DismissReason)}
      >
        {DISMISS_REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <label className="check small">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember for this repository
      </label>
      <Button size="sm" type="submit" variant="destructive-outline" disabled={busy}>
        Dismiss
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </form>
  );
}
