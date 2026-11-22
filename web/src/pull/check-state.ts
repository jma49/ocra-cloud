// "A check failed", not "Checks fail": one failing check sets this state, and
// it may not be a required one.
export const CHECKS = {
  passing: { label: "Checks pass", cls: "ok" },
  failing: { label: "A check failed", cls: "fail" },
  pending: { label: "Checks running", cls: "wait" },
} as const;
