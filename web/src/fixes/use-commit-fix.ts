import { useState } from "react";
import type { PullActionOutcome } from "../../../src/shared/index.js";
import { api } from "../api.js";

export type CommitState = PullActionOutcome | "error" | "sending" | null;

/** Commits a finding's fix to its pull request, as the signed-in user. */
export function useCommitFix(finding: string, onDone?: (outcome: PullActionOutcome) => void) {
  const [state, setState] = useState<CommitState>(null);
  const commit = async () => {
    setState("sending");
    try {
      const r = await api<{ outcome: PullActionOutcome }>("/pulls/apply-fix", {
        method: "POST",
        body: JSON.stringify({ finding }),
      });
      setState(r.outcome);
      onDone?.(r.outcome);
    } catch {
      setState("error");
    }
  };
  return { state, commit };
}
