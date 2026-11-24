import FilterX from "lucide-react/icons/filter-x";
import Flag from "lucide-react/icons/flag";
import { Button } from "@/components/ui/button";
import type { FindingStatus } from "../../src/shared/index.js";
import { FINDING_STATUS_NAME } from "./finding-status.js";
import { Link } from "./router.js";
import { EmptyState } from "./ui.js";

const UNFILTERED = { severity: "", verification: "", repo: "", rule: "" } as const;

type Narrowing = {
  status: FindingStatus | "all";
  severity: string;
  verification: string;
  repo: string;
  rule: string;
};

/**
 * Findings' empty list: for an account with findings the filters hide, a way
 * to clear them; for one with none, where findings come from.
 */
export function FindingsEmpty(props: {
  /** Whether this server runs reviews itself. */
  runner?: boolean | undefined;
  /** The account's findings by status, whatever the filters. */
  statuses: Record<FindingStatus, number>;
  filters: Narrowing;
  set: (change: typeof UNFILTERED | { status: "all" }) => void;
}) {
  const { status, severity, verification, repo, rule } = props.filters;
  const kind = status === "all" ? "" : `${FINDING_STATUS_NAME[status].toLowerCase()} `;
  if (!Object.values(props.statuses).some((n) => n > 0)) {
    return (
      <EmptyState
        icon={Flag}
        title="No findings here"
        action={
          props.runner ? (
            <Button variant="outline" render={<Link to="/auto-review" />}>
              Set up auto review
            </Button>
          ) : (
            <Button variant="outline" render={<Link to="/settings" />}>
              Open settings
            </Button>
          )
        }
      >
        {props.runner
          ? "Findings come from ocra's reviews of pull requests in repositories with auto review on, and from CLI reviews once you turn on sharing in Settings."
          : "Findings appear once you turn on sharing in Settings and a signed-in review uploads them."}
      </EmptyState>
    );
  }
  return severity || verification || repo || rule ? (
    <EmptyState
      icon={FilterX}
      title="No finding matches these filters"
      action={
        <Button variant="outline" onClick={() => props.set(UNFILTERED)}>
          Clear filters
        </Button>
      }
    >
      Clear the filters to see every {kind}finding.
    </EmptyState>
  ) : (
    <EmptyState
      icon={FilterX}
      title={`No ${kind}findings`}
      action={
        <Button variant="outline" onClick={() => props.set({ status: "all" })}>
          Show all findings
        </Button>
      }
    >
      Your other findings are under All.
    </EmptyState>
  );
}
