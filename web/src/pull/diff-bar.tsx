import Columns2 from "lucide-react/icons/columns-2";
import Pilcrow from "lucide-react/icons/pilcrow";
import Rows2 from "lucide-react/icons/rows-2";
import WrapText from "lucide-react/icons/wrap-text";
import { Seg } from "../ui.js";
import { ViewToggle } from "../view-toggle.js";
import type { useDiffLayout, useDiffWhitespace, useDiffWrap } from "./diff-layout.js";

/**
 * Beside the changes shown: whether whitespace-only changes are left out,
 * whether long lines wrap, and whether diffs are unified or side by side,
 * each an icon named in its tooltip. A phone wraps and draws them unified.
 */
export function DiffBar(props: {
  layout: ReturnType<typeof useDiffLayout>;
  wrap: ReturnType<typeof useDiffWrap>;
  whitespace: ReturnType<typeof useDiffWhitespace>;
}) {
  const { layout, wrap, whitespace } = props;
  return (
    <div className="diff-bar">
      <ViewToggle
        label="Hide whitespace"
        icon={Pilcrow}
        pressed={whitespace.hidden}
        onChange={whitespace.pick}
      />
      {!layout.narrow && (
        <>
          <ViewToggle
            label="Wrap lines"
            icon={WrapText}
            pressed={wrap.picked}
            onChange={wrap.pick}
          />
          <span className="diff-bar-rule" aria-hidden="true" />
          <Seg
            label="Diff layout"
            value={layout.picked}
            options={[
              { value: "unified", label: "Unified", icon: Rows2 },
              { value: "split", label: "Split", icon: Columns2 },
            ]}
            onChange={layout.pick}
          />
        </>
      )}
    </div>
  );
}
