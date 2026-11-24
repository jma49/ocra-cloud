import GitMerge from "lucide-react/icons/git-merge";
import { useEffect, useRef } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  MAX_DAILY_FIX_REQUESTS,
  type MendConflictView,
  type MendRequestView,
  type PullMendView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction, useLoad, usePoll } from "../ui.js";
import { ConflictSuggestion } from "./conflict-suggestion.js";

// Asks ocra to resolve a pull request's merge conflicts, from the readiness
// section that says it has them: where the repository lets ocra merge the
// base branch, one merge commit, which the page then reads; elsewhere a
// suggested resolution, which writes nothing.

const ACTIVE_MS = 5_000;

type Pull = { platform: string; repo: string; number: number };

const LEFT: Partial<Record<NonNullable<MendConflictView["reason"]>, string>> = {
  declined: "ocra could not keep both sides' changes",
  failed: "ocra's call to the model did not go through",
  not_candidate: "it was deleted, renamed or is not text on one side",
  too_large: "the conflict is too large",
  protected: "it is a file ocra does not edit",
  unresolved: "its resolution did not pass ocra's check of it",
  unsure: "ocra could not tell that its resolution was right",
  unchecked: "the check of its resolution failed",
  syntax: "its resolution did not parse",
  unsafe: "its resolution did not pass the safety check",
  attempts: "ocra tried twice",
  head_moved: "the branch moved while ocra worked",
  not_writable: "ocra cannot push to this branch",
};

/** Why the last round wrote no merge, by the first file it left. */
function left(conflicts: MendConflictView[]): string | null {
  const file = conflicts.find(
    (c) => c.outcome !== "fixed" && c.outcome !== "proposed" && c.reason !== "conflicts",
  );
  if (!file) return null;
  const why = (file.reason && LEFT[file.reason]) ?? "ocra gave no reason";
  return `ocra left the merge to a person: ${file.path}, ${why}.`;
}

const turning = (mend: PullMendView | undefined) =>
  mend?.loop?.state === "queued" || mend?.loop?.state === "running";

export function ResolveConflicts(props: {
  pull: Pull;
  /** Reads the pull request again, once a round ends. */
  onChanged: () => void;
}) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) }).toString();
  const { data: mend, reload } = useLoad(() => api<PullMendView>(`/auto-review/mends?${q}`), [q]);
  const busy = turning(mend);
  usePoll(busy, reload, ACTIVE_MS);
  const changed = useRef(props.onChanged);
  changed.current = props.onChanged;
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !busy) changed.current();
    was.current = busy;
  }, [busy]);
  const ask = useAction(async () => {
    await api<MendRequestView>("/auto-review/mends/conflicts", {
      method: "POST",
      body: JSON.stringify(props.pull),
    });
    reload();
  });
  if (!mend || (!mend.resolves && !mend.suggests)) return null;
  if (busy) {
    return (
      <div className="stack update-branch" role="status">
        <Status tone="run">
          {mend.loop?.state !== "running"
            ? "Queued for ocra"
            : mend.resolves
              ? "ocra is working on this branch"
              : "ocra is working out a resolution"}
        </Status>
      </div>
    );
  }
  const said = left(mend.conflicts);
  const suggested = mend.conflicts.some((c) => c.outcome === "proposed");
  return (
    <div className="stack update-branch">
      <Button type="button" variant="outline" size="sm" loading={ask.busy} onClick={ask.run}>
        <GitMerge size={14} aria-hidden="true" />
        {mend.resolves
          ? said
            ? "Try resolving the conflicts again"
            : "Resolve conflicts with ocra"
          : said || suggested
            ? "Suggest a resolution again"
            : "Suggest a resolution"}
      </Button>
      {ask.error !== null ? (
        <p className="error small" role="alert">
          {ask.error instanceof ApiError && ask.error.code === "daily_limit"
            ? `Today's ${MAX_DAILY_FIX_REQUESTS} fixes are used up. Ask again tomorrow.`
            : `Could not ask ocra: ${why(ask.error)}.`}
        </p>
      ) : (
        <span className="subtle small" role="status">
          {said ??
            (mend.resolves
              ? "ocra merges the base branch into this one and resolves the conflicts in one merge commit. It never rebases or force-pushes."
              : suggested
                ? null
                : "ocra suggests how to resolve each conflict and writes nothing to this branch.")}
        </span>
      )}
      {!mend.resolves && <ConflictSuggestion conflicts={mend.conflicts} />}
    </div>
  );
}
