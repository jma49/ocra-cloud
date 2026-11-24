import { Seg } from "../ui.js";
import type { useDiffLayout, useDiffWhitespace, useDiffWrap } from "./diff-layout.js";

/**
 * Over the diffs: whether whitespace-only changes are left out, whether long
 * lines wrap, and whether diffs are unified or side by side. A phone wraps
 * and draws them unified.
 */
export function DiffBar(props: {
  layout: ReturnType<typeof useDiffLayout>;
  wrap: ReturnType<typeof useDiffWrap>;
  whitespace: ReturnType<typeof useDiffWhitespace>;
}) {
  const { layout, wrap, whitespace } = props;
  return (
    <div className="diff-bar">
      <label className="check small">
        <input
          type="checkbox"
          checked={whitespace.hidden}
          onChange={(e) => whitespace.pick(e.target.checked)}
        />
        Hide whitespace
      </label>
      {!layout.narrow && (
        <>
          <label className="check small">
            <input
              type="checkbox"
              checked={wrap.picked}
              onChange={(e) => wrap.pick(e.target.checked)}
            />
            Wrap lines
          </label>
          <Seg
            label="Diff layout"
            value={layout.picked}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
            onChange={layout.pick}
          />
        </>
      )}
    </div>
  );
}
