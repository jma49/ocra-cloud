import type { PageCommand } from "../page-commands.js";
import { navigate } from "../router.js";

type Row = { id: string; reviewId: string; title: string };

/**
 * What the findings list does from the keyboard and the command menu. A
 * decision acts on the selected findings, or on the current one when none
 * is; dismissing asks for its reason in the bar first.
 */
export function findingsCommands(list: {
  row: Row | undefined;
  selected: ReadonlySet<string>;
  move: (step: 1 | -1) => void;
  toggle: (id: string) => void;
  markFixed: (ids: string[]) => void;
  dismiss: (ids: string[]) => void;
  clear: () => void;
}): PageCommand[] {
  const { row } = list;
  const targets = list.selected.size > 0 ? [...list.selected] : row ? [row.id] : [];
  return [
    { label: "Next finding", key: "j", run: () => list.move(1) },
    { label: "Previous finding", key: "k", run: () => list.move(-1) },
    ...(row
      ? [
          { label: "Select or unselect", key: "x", run: () => list.toggle(row.id) },
          {
            label: "Open its review",
            key: "Enter",
            run: () => navigate(`/reviews/${row.reviewId}`),
          },
        ]
      : []),
    ...(targets.length > 0
      ? [
          { label: "Mark fixed", key: "f", run: () => list.markFixed(targets) },
          { label: "Dismiss with a reason", key: "d", run: () => list.dismiss(targets) },
        ]
      : []),
    ...(list.selected.size > 0 ? [{ label: "Clear selection", run: list.clear }] : []),
  ];
}
