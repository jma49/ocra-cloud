import ArrowDown from "lucide-react/icons/arrow-down";
import ArrowUp from "lucide-react/icons/arrow-up";
import ChevronsUpDown from "lucide-react/icons/chevrons-up-down";
import type { Expand } from "./context-lines.js";
import { type OpenGap, STEP } from "./diff-context.js";

// A hunk's head, and where the diff left lines out above it, the buttons that
// show them: a few at a time from either side, or all of a short gap at once.

export function GapRow(props: {
  text: string;
  gap: OpenGap | undefined;
  /** The gap being read, by key; its buttons wait. */
  busy: number | null;
  expand: Expand | undefined;
  columns: number;
}) {
  const { gap, expand } = props;
  const first = gap?.gap.key === 0;
  const last = gap?.gap.to === null;
  const short = gap?.hidden !== null && gap?.hidden !== undefined && gap.hidden <= STEP;
  const button = (direction: "up" | "down" | "all", label: string, icon: React.ReactNode) =>
    gap &&
    expand && (
      <button
        type="button"
        className="diff-expand"
        aria-label={label}
        title={label}
        disabled={props.busy !== null}
        onClick={() => expand(gap.gap, direction)}
      >
        {icon}
      </button>
    );
  return (
    <tr className="diff-hunk">
      <td colSpan={props.columns}>
        <div className="diff-hunk-row">
          {gap && expand && (
            <span className="diff-expands">
              {short || (first && last) ? (
                button(
                  "all",
                  `Show ${gap.hidden ?? ""} hidden lines`.replace("  ", " "),
                  <ChevronsUpDown size={14} aria-hidden="true" />,
                )
              ) : (
                <>
                  {!first &&
                    button(
                      "down",
                      `Show ${STEP} lines below the change above`,
                      <ArrowDown size={14} aria-hidden="true" />,
                    )}
                  {!last &&
                    button(
                      "up",
                      `Show ${STEP} lines above the change below`,
                      <ArrowUp size={14} aria-hidden="true" />,
                    )}
                </>
              )}
            </span>
          )}
          <span className="diff-hunk-text">{props.text}</span>
          {gap?.hidden !== null && gap?.hidden !== undefined && (
            <span className="diff-hidden">{gap.hidden} hidden</span>
          )}
        </div>
      </td>
    </tr>
  );
}
