import { Seg } from "../ui.js";
import type { useDiffLayout } from "./diff-layout.js";

/** Over the diffs: whether they are drawn unified or side by side. A phone draws them unified. */
export function DiffBar(props: { layout: ReturnType<typeof useDiffLayout> }) {
  const { layout } = props;
  if (layout.narrow) return null;
  return (
    <div className="diff-bar">
      <Seg
        label="Diff layout"
        value={layout.picked}
        options={[
          { value: "unified", label: "Unified" },
          { value: "split", label: "Split" },
        ]}
        onChange={layout.pick}
      />
    </div>
  );
}
