import type { Severity } from "../../src/shared/index.js";

const SEVERITY = {
  critical: { label: "Critical", cls: "badge-err" },
  warning: { label: "Warning", cls: "badge-warn" },
  suggestion: { label: "Suggestion", cls: "" },
} as const;

/** A finding's severity as a badge. */
export function SeverityBadge(props: { severity: Severity }) {
  const s = SEVERITY[props.severity];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
