import CircleCheck from "lucide-react/icons/circle-check";
import CircleDashed from "lucide-react/icons/circle-dashed";
import CircleX from "lucide-react/icons/circle-x";
import { CHECKS } from "./check-state.js";

const ICON = { passing: CircleCheck, failing: CircleX, pending: CircleDashed } as const;

/** How a pull request's checks stand, in one mark; an empty box of the same width where unknown. */
export function CheckMark(props: { checks: keyof typeof CHECKS | null | undefined }) {
  if (!props.checks) return <span className="chk" aria-hidden="true" />;
  const { label, cls } = CHECKS[props.checks];
  const Icon = ICON[props.checks];
  return (
    <span className={`chk ${cls}`} role="img" aria-label={label} title={label}>
      <Icon size={14} aria-hidden="true" />
    </span>
  );
}
