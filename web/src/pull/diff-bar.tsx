import SlidersHorizontal from "lucide-react/icons/sliders-horizontal";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyCaps } from "../shortcuts/keys.js";
import type { useDiffLayout, useDiffWhitespace, useDiffWrap } from "./diff-layout.js";
import type { DiffLayout } from "./diff-rows.js";

const LABEL = "Diff settings";

/**
 * Beside the changes shown, one menu of how diffs are drawn: unified or side
 * by side, whether whitespace-only changes are left out, and whether long
 * lines wrap. A phone draws them unified and wrapped, so it offers whitespace alone.
 */
export function DiffBar(props: {
  layout: ReturnType<typeof useDiffLayout>;
  wrap: ReturnType<typeof useDiffWrap>;
  whitespace: ReturnType<typeof useDiffWhitespace>;
}) {
  const { layout, wrap, whitespace } = props;
  return (
    <div className="diff-bar">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button type="button" variant="ghost" size="icon-sm" aria-label={LABEL} />}
              />
            }
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{LABEL}</TooltipPopup>
        </Tooltip>
        <MenuPopup className="diff-settings" align="end">
          {!layout.narrow && (
            <>
              <MenuGroup>
                <MenuGroupLabel>Layout</MenuGroupLabel>
                <MenuRadioGroup
                  value={layout.picked}
                  onValueChange={(v) => layout.pick(v as DiffLayout)}
                >
                  <MenuRadioItem value="unified">Unified</MenuRadioItem>
                  <MenuRadioItem value="split">Split</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
            </>
          )}
          <MenuCheckboxItem
            className="diff-settings-item"
            checked={whitespace.hidden}
            onCheckedChange={whitespace.pick}
            aria-keyshortcuts="w"
          >
            Hide whitespace
            <span className="diff-settings-key" aria-hidden="true">
              <KeyCaps keys="w" />
            </span>
          </MenuCheckboxItem>
          {!layout.narrow && (
            <MenuCheckboxItem checked={wrap.picked} onCheckedChange={wrap.pick}>
              Wrap lines
            </MenuCheckboxItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}
