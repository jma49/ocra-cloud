import type { LucideIcon } from "lucide-react";
import Lightbulb from "lucide-react/icons/lightbulb";
import OctagonAlert from "lucide-react/icons/octagon-alert";
import TriangleAlert from "lucide-react/icons/triangle-alert";
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

const MARK: Record<Severity, LucideIcon> = {
  critical: OctagonAlert,
  warning: TriangleAlert,
  suggestion: Lightbulb,
};

/** A severity's mark in its colour, beside words that already name it. */
export function SeverityMark(props: { severity: Severity }) {
  const Icon = MARK[props.severity];
  return <Icon size={14} className={`sev-mark sev-${props.severity}`} aria-hidden="true" />;
}
