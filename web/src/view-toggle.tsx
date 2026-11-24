import type { LucideIcon } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/** A view setting that is on or off, as an icon pressed in or not, named in its tooltip. */
export function ViewToggle(props: {
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="view-toggle"
            size="sm"
            aria-label={props.label}
            pressed={props.pressed}
            onPressedChange={props.onChange}
          />
        }
      >
        <Icon size={14} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
