import type { LucideIcon } from "lucide-react";
import Check from "lucide-react/icons/check";
import Plus from "lucide-react/icons/plus";
import X from "lucide-react/icons/x";

// Control glyphs (close, add, done) are line icons at one weight. Each is
// imported alone: the package's index loads every icon it has.
function glyph(Icon: LucideIcon) {
  return (props: { size?: number }) => (
    <Icon
      className="glyph"
      size={props.size ?? 16}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
    />
  );
}

export const CloseGlyph = glyph(X);
export const AddGlyph = glyph(Plus);
export const DoneGlyph = glyph(Check);
