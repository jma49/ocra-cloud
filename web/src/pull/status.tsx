import type { PullReadinessView, PullState, QueueState } from "../../../src/shared/index.js";
import { QUEUE_STATE } from "./queue-words.js";

// A pull request's standing in a word or two, for the head of its page: what
// it is (a draft, merged) and the first thing in the way of its merge.

type Badge = { text: string; tone: string };

/** What the user would do next on it: mark it ready, review it, or merge it. */
export type NextStep = "ready" | "review" | "merge";

const unmet = (view: PullReadinessView | undefined, kind: string) =>
  view?.items.some((i) => i.kind === kind && i.state === "unmet") === true;

const isDraft = (view: PullReadinessView | undefined) => unmet(view, "draft");

export function nextStep(view: PullReadinessView | undefined, canMerge: boolean): NextStep {
  if (isDraft(view)) return "ready";
  return view?.ready === "met" && canMerge ? "merge" : "review";
}

function badges(
  state: PullState | null,
  view: PullReadinessView | undefined,
  queued: QueueState | null,
): Badge[] {
  if (state === "merged") return [{ text: "Merged", tone: "badge badge-ok" }];
  if (state === "closed") return [{ text: "Closed", tone: "badge" }];
  // In the queue its merge is no longer the user's to start: the queue's word for it, as its card says it.
  if (queued) return [{ text: QUEUE_STATE[queued].label, tone: QUEUE_STATE[queued].tone }];
  const draft = isDraft(view);
  const conflicts = unmet(view, "conflicts");
  const shown: Badge[] = [];
  if (draft) shown.push({ text: "Draft", tone: "badge" });
  if (conflicts) shown.push({ text: "Conflicts", tone: "badge badge-err" });
  if (draft || conflicts || !view?.ready) return shown;
  if (view.ready === "met") return [{ text: "Ready to merge", tone: "badge badge-ok" }];
  // Quiet here: the readiness card marks each requirement that is not met.
  if (view.ready === "unmet") return [{ text: "Not ready", tone: "badge" }];
  return view.ready === "pending" ? [{ text: "Waiting", tone: "badge" }] : [];
}

export function PullStatus(props: {
  state: PullState | null;
  view: PullReadinessView | undefined;
  /** Where it stands in the merge queue; null when it is in none. */
  queued: QueueState | null;
}) {
  return (
    <>
      {badges(props.state, props.view, props.queued).map((b) => (
        <span key={b.text} className={b.tone}>
          {b.text}
        </span>
      ))}
    </>
  );
}
