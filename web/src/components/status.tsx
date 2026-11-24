import type { LucideIcon } from "lucide-react";
import CircleAlert from "lucide-react/icons/circle-alert";
import CircleCheck from "lucide-react/icons/circle-check";
import CircleDashed from "lucide-react/icons/circle-dashed";
import CircleDot from "lucide-react/icons/circle-dot";
import CircleX from "lucide-react/icons/circle-x";
import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "err" | "run" | "quiet";

const ICON: Record<StatusTone, LucideIcon> = {
  ok: CircleCheck,
  warn: CircleAlert,
  err: CircleX,
  run: CircleDot,
  quiet: CircleDashed,
};

/**
 * How something stands, as a mark and a word in its tone, with no fill or edge,
 * so it never reads as a button beside the actions it sits with (web/DESIGN.md).
 */
export function Status(props: {
  tone: StatusTone;
  icon?: LucideIcon;
  title?: string | undefined;
  children: ReactNode;
}) {
  const Icon = props.icon ?? ICON[props.tone];
  return (
    <span className={`status status-${props.tone}`} title={props.title}>
      <Icon size={14} aria-hidden="true" />
      {props.children}
    </span>
  );
}
