import type { PageCommand } from "../page-commands.js";
import type { Row } from "./sections.js";

/** What the inbox does from the keyboard and the command menu; a row's commands act on the current row. */
export function inboxCommands(inbox: {
  row: Row | undefined;
  move: (step: 1 | -1) => void;
  open: () => void;
  find: () => void;
  refresh: () => void;
  toggleRead: (row: Row) => void;
  markAllRead: (() => void) | null;
  newSection: () => void;
}): PageCommand[] {
  const { row } = inbox;
  return [
    { label: "Next pull request", key: "j", run: () => inbox.move(1) },
    { label: "Previous pull request", key: "k", run: () => inbox.move(-1) },
    ...(row
      ? [
          { label: "Open pull request", key: "Enter", run: inbox.open },
          {
            label: "Open on the platform",
            key: "o",
            run: () => void window.open(row.url, "_blank", "noopener,noreferrer"),
          },
          {
            label: row.unread ? "Mark read" : "Mark unread",
            key: "u",
            run: () => inbox.toggleRead(row),
          },
        ]
      : []),
    { label: "Find pull requests", key: "/", run: inbox.find },
    { label: "Refresh", key: "r", run: inbox.refresh },
    ...(inbox.markAllRead ? [{ label: "Mark all read", run: inbox.markAllRead }] : []),
    { label: "New section", run: inbox.newSection },
  ];
}
