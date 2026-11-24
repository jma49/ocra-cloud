import type { LucideIcon } from "lucide-react";
import Lightbulb from "lucide-react/icons/lightbulb";
import OctagonAlert from "lucide-react/icons/octagon-alert";
import TriangleAlert from "lucide-react/icons/triangle-alert";
import type { Severity } from "../../src/shared/index.js";
import { count } from "./format.js";

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
function SeverityMark(props: { severity: Severity }) {
  const Icon = MARK[props.severity];
  return <Icon size={14} className={`sev-mark sev-${props.severity}`} aria-hidden="true" />;
}

/** Counts by severity, the empty ones left out: the severity's mark in its colour and the count in words. */
export function SeverityCounts(props: { counts: Record<Severity, number> }) {
  const shown = (["critical", "warning", "suggestion"] as const).filter((s) => props.counts[s] > 0);
  if (shown.length === 0) return <span className="muted">None</span>;
  return (
    <span className="sev-counts">
      {shown.map((severity) => (
        <span key={severity} className="sev-count">
          <SeverityMark severity={severity} />
          {count(props.counts[severity], severity)}
        </span>
      ))}
    </span>
  );
}
