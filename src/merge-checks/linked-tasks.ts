import type { LinkedTaskView, MergeCheckResultView, MergeCheckSettings } from "../shared/index.js";

// The linked issue check, from the tasks the head's review uploaded:
// undefined when the review did not look them up, [] when it found none.

type Judged = Pick<MergeCheckResultView, "outcome" | "detail">;

export function judgeLinkedTasks(
  settings: MergeCheckSettings["linked_issue"],
  tasks: readonly LinkedTaskView[] | undefined,
): Judged {
  if (tasks === undefined) {
    return {
      outcome: "not_evaluated",
      detail: "not evaluated yet: no ocra review of this head looked up its linked issues",
    };
  }
  const read = tasks.filter((t): t is NonNullable<LinkedTaskView> => t !== null);
  if (tasks.length === 0) return { outcome: "failed", detail: "no linked issue" };
  if (read.length === 0) {
    return {
      outcome: "not_evaluated",
      detail: "not evaluated: the linked issues could not be read",
    };
  }
  const open = settings.open ? read.filter((t) => t.state === "open") : read;
  if (open.length === 0) return { outcome: "failed", detail: "no linked issue is open" };
  const label = settings.label?.toLowerCase();
  if (label === undefined)
    return { outcome: "passed", detail: `links ${open.map((t) => t.key).join(", ")}` };
  if (open.every((t) => t.labels === undefined)) {
    return {
      outcome: "not_evaluated",
      detail: "not evaluated: labels are uploaded only while the account shares findings",
    };
  }
  const labelled = open.filter((t) => t.labels?.some((l) => l.toLowerCase() === label));
  return labelled.length > 0
    ? { outcome: "passed", detail: `links ${labelled.map((t) => t.key).join(", ")}` }
    : { outcome: "failed", detail: `no linked issue carries the label "${settings.label}"` };
}
