import type { DismissReason } from "../../src/shared/index.js";

/** Why a finding is dismissed, as every page that dismisses one names it. */
export const DISMISS_REASONS: readonly { value: DismissReason; label: string }[] = [
  { value: "false_positive", label: "False positive" },
  { value: "not_important", label: "Not important" },
  { value: "wrong_fix", label: "Suggested fix is wrong" },
  { value: "already_known", label: "Already known" },
];

export const reasonLabel = (r: DismissReason) =>
  DISMISS_REASONS.find((x) => x.value === r)?.label ?? r;
