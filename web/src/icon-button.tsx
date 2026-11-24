import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A control whose icon says what it does (copy, refresh, download): the icon
 * alone, its name in a tooltip on hover and focus and as its accessible name.
 */
export function IconButton(
  props: {
    label: string;
    icon: LucideIcon;
  } & Omit<ComponentProps<typeof Button>, "children" | "size" | "aria-label">,
) {
  const { label, icon: Icon, variant, ...rest } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={variant ?? "ghost"}
            size="icon-sm"
            aria-label={label}
            {...rest}
          />
        }
      >
        <Icon size={14} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
