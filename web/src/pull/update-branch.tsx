import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BranchUpdateOutcome, PullUpdateBranchAnswer } from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction } from "../ui.js";

// Brings a branch that fell behind its base up to date, as the signed-in
// user, from the readiness section that says it is behind.

const SAID: Record<BranchUpdateOutcome, string> = {
  updating: "The platform is updating the branch; its new head follows shortly.",
  up_to_date: "The branch already has everything from its base.",
  conflicts: "The branch conflicts with its base: only a manual merge resolves it.",
  forbidden: "Your sign-in may not push to this branch.",
  not_open: "This pull request is no longer open.",
};

/** The platform updates asynchronously: the page looks again after this long. */
const LOOK_AGAIN_MS = 4_000;

type Pull = { platform: string; repo: string; number: number };

export function UpdateBranch(props: {
  pull: Pull;
  head: string;
  /** Reads the pull request and what it waits on again. */
  onChanged: () => void;
  /** Set where what surrounds it already says the branch is behind. */
  bare?: boolean;
}) {
  const [said, setSaid] = useState<BranchUpdateOutcome | null>(null);
  const [waiting, setWaiting] = useState(false);
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changed = useRef(props.onChanged);
  changed.current = props.onChanged;
  useEffect(() => () => clearTimeout(later.current), []);
  const update = useAction(() =>
    api<PullUpdateBranchAnswer>("/pulls/update-branch", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: props.head }),
    }),
  );
  // A head that moved since the page read it: what the page shows is out of date.
  const moved = update.error instanceof ApiError && update.error.status === 409;
  const send = async () => {
    setSaid(null);
    const r = await update.run();
    if (!r) return;
    setSaid(r.outcome);
    if (r.outcome !== "updating") return changed.current();
    setWaiting(true);
    clearTimeout(later.current);
    later.current = setTimeout(() => {
      setWaiting(false);
      changed.current();
    }, LOOK_AGAIN_MS);
  };
  useEffect(() => {
    if (moved) changed.current();
  }, [moved]);
  return (
    <div className="stack update-branch">
      {!props.bare && <span className="subtle small">This branch is behind its base.</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={update.busy}
        disabled={waiting}
        onClick={send}
      >
        Update branch
      </Button>
      {said && (
        <span className={said === "updating" ? "subtle small" : "small"} role="status">
          {SAID[said]}
        </span>
      )}
      {update.error !== null && (
        <p className="error small" role="alert">
          {moved
            ? "The pull request moved since this page read it; reading it again."
            : `Could not update the branch: ${why(update.error)}.`}
        </p>
      )}
    </div>
  );
}
