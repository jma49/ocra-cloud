import ChevronDown from "lucide-react/icons/chevron-down";
import ChevronUp from "lucide-react/icons/chevron-up";
import type { ComponentType } from "react";
import { Link } from "../router.js";
import { useBeside } from "./queue.js";

function Step(props: {
  to: string | null;
  label: string;
  keyed: string;
  icon: ComponentType<{ size: number }>;
}) {
  const Icon = props.icon;
  if (!props.to) {
    return (
      <span className="icon-btn is-off" aria-hidden="true">
        <Icon size={16} />
      </span>
    );
  }
  return (
    <Link
      to={props.to}
      className="icon-btn"
      label={props.label}
      title={`${props.label} (${props.keyed})`}
    >
      <Icon size={16} aria-hidden="true" />
    </Link>
  );
}

/** On a pull request opened from the inbox: its place there, and the ones beside it. */
export function QueueNav(props: { path: string }) {
  const beside = useBeside(props.path);
  if (!beside || beside.total < 2) return null;
  return (
    <nav className="queue-nav" aria-label="Pull requests in the inbox">
      <span className="queue-at">
        {beside.at} of {beside.total}
      </span>
      <Step to={beside.previous} label="Previous pull request" keyed="[" icon={ChevronUp} />
      <Step to={beside.next} label="Next pull request" keyed="]" icon={ChevronDown} />
    </nav>
  );
}
