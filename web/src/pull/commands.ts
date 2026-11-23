import type { RefObject } from "react";
import type { PullFilesView } from "../../../src/shared/index.js";
import type { PageCommand } from "../page-commands.js";

export const MERGE_ID = "merge";

/** The file whose top is the first below the window's reading line, or the last above it. */
function fileBeside(code: HTMLElement | null, step: 1 | -1): Element | undefined {
  const files = [...(code?.querySelectorAll(".diff-file") ?? [])];
  const line = Number.parseFloat(getComputedStyle(files[0] ?? document.body).scrollMarginTop) || 0;
  const top = (el: Element) => Math.round(el.getBoundingClientRect().top - line);
  return step === 1 ? files.find((f) => top(f) > 1) : files.findLast((f) => top(f) < -1);
}

/** What a pull request's page does from the keyboard and the command menu. */
export function pullCommands(page: {
  data: PullFilesView | undefined;
  code: RefObject<HTMLElement | null>;
  review: () => void;
}): PageCommand[] {
  const { data, code } = page;
  if (!data) return [];
  const open = data.state !== "merged" && data.state !== "closed";
  const { url } = data;
  const to = (el: Element | null | undefined) => el?.scrollIntoView({ block: "start" });
  return [
    ...(data.verdicts.length > 0 ? [{ label: "Review changes", key: "r", run: page.review }] : []),
    { label: "Jump to code", key: "c", run: () => to(code.current) },
    { label: "Next file", key: "j", run: () => to(fileBeside(code.current, 1)) },
    { label: "Previous file", key: "k", run: () => to(fileBeside(code.current, -1)) },
    ...(open
      ? [{ label: "Go to merge", key: "m", run: () => to(document.getElementById(MERGE_ID)) }]
      : []),
    ...(url
      ? [
          {
            label: "Open on the platform",
            key: "o",
            run: () => void window.open(url, "_blank", "noopener,noreferrer"),
          },
        ]
      : []),
  ];
}
