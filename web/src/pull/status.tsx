import type { LucideIcon } from "lucide-react";
import CircleAlert from "lucide-react/icons/circle-alert";
import CircleDashed from "lucide-react/icons/circle-dashed";
import Clock from "lucide-react/icons/clock";
import GitMerge from "lucide-react/icons/git-merge";
import GitPullRequestClosed from "lucide-react/icons/git-pull-request-closed";
import GitPullRequestDraft from "lucide-react/icons/git-pull-request-draft";
import ListOrdered from "lucide-react/icons/list-ordered";
import { Status, type StatusTone } from "@/components/status";
import type { PullReadinessView, PullState, QueueState } from "../../../src/shared/index.js";
import { QUEUE_STATE } from "./queue-words.js";

// A pull request's standing in a word or two, for the head of its page: what
// it is (a draft, merged) and the first thing in the way of its merge. It is
// a state, read on the meta line as an icon and a word, not a control.

type Badge = { text: string; tone: StatusTone; icon: LucideIcon };

/** A badge's tone (`badge badge-err`) as the state's tone (`err`). */
const toneOf = (badge: string) => (badge.replace(/^badge ?(badge-)?/, "") || "quiet") as StatusTone;

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
  if (state === "merged") return [{ text: "Merged", tone: "ok", icon: GitMerge }];
  if (state === "closed") return [{ text: "Closed", tone: "quiet", icon: GitPullRequestClosed }];
  // In the queue its merge is no longer the user's to start: the queue's word for it, as its card says it.
  if (queued) {
    const q = QUEUE_STATE[queued];
    return [{ text: q.label, tone: toneOf(q.tone), icon: ListOrdered }];
  }
  const draft = isDraft(view);
  const conflicts = unmet(view, "conflicts");
  const shown: Badge[] = [];
  if (draft) shown.push({ text: "Draft", tone: "quiet", icon: GitPullRequestDraft });
  if (conflicts) shown.push({ text: "Conflicts", tone: "err", icon: CircleAlert });
  if (draft || conflicts || !view?.ready) return shown;
  if (view.ready === "met") return [{ text: "Ready to merge", tone: "ok", icon: GitMerge }];
  // Quiet here: the readiness card marks each requirement that is not met.
  if (view.ready === "unmet") return [{ text: "Not ready", tone: "quiet", icon: CircleDashed }];
  return view.ready === "pending" ? [{ text: "Waiting", tone: "quiet", icon: Clock }] : [];
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
        <Status key={b.text} tone={b.tone} icon={b.icon}>
          {b.text}
        </Status>
      ))}
    </>
  );
}
