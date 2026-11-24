import type { RefObject } from "react";
import type { PullFilesView } from "../../../src/shared/index.js";
import type { Beside } from "../inbox/queue.js";
import type { PageCommand } from "../page-commands.js";
import { navigate } from "../router.js";

export const MERGE_ID = "merge";
/** The key that opens Ask ocra about the pull request. */
export const ASK_KEY = "q";

/** The file whose top is the first below the window's reading line, or the last above it. */
function fileBeside(code: HTMLElement | null, step: 1 | -1): Element | undefined {
  const files = [...(code?.querySelectorAll(".diff-file") ?? [])];
  const line = Number.parseFloat(getComputedStyle(files[0] ?? document.body).scrollMarginTop) || 0;
  const top = (el: Element) => Math.round(el.getBoundingClientRect().top - line);
  return step === 1 ? files.find((f) => top(f) > 1) : files.findLast((f) => top(f) < -1);
}

/** The file being read: the last whose top has reached the reading line, else the first. */
function fileAtLine(code: HTMLElement | null): HTMLElement | undefined {
  const files = [...(code?.querySelectorAll<HTMLElement>(".diff-file") ?? [])];
  const line = Number.parseFloat(getComputedStyle(files[0] ?? document.body).scrollMarginTop) || 0;
  return files.findLast((f) => f.getBoundingClientRect().top - line <= 1) ?? files[0];
}

/** ocra's next finding on the diff below the middle of the window, or the last above it. */
function findingBeside(code: HTMLElement | null, step: 1 | -1): Element | undefined {
  const notes = [...(code?.querySelectorAll(".finding-note") ?? [])];
  const middle = window.innerHeight / 2;
  const at = (el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.top + r.height / 2 - middle);
  };
  return step === 1 ? notes.find((n) => at(n) > 1) : notes.findLast((n) => at(n) < -1);
}

/** Brings a part of the page into view and puts the keys on its first control that can act, so Enter does the next step. */
function reach(el: Element | null | undefined, block: ScrollLogicalPosition): boolean {
  if (!el) return false;
  el.scrollIntoView({ block });
  el.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  return true;
}

const step = (label: string, key: string, to: string | null | undefined): PageCommand[] =>
  to ? [{ label, key, run: () => navigate(to) }] : [];

/** What a pull request's page does from the keyboard and the command menu. */
export function pullCommands(page: {
  data: PullFilesView | undefined;
  code: RefObject<HTMLElement | null>;
  review: () => void;
  /** Opens Ask ocra about the pull request. */
  ask?: () => void;
  /** Ticks or unticks a file as viewed, by its path. */
  toggleViewed: (path: string) => void;
  /** Opens or folds the conversation column beside the diff. */
  toggleConversation?: () => void;
  /** Draws the diffs the other way, unified or split; undefined where only one fits. */
  switchLayout?: { to: "unified" | "split"; run: () => void } | undefined;
  /** Leaves whitespace-only changes out of the diffs, or puts them back. */
  whitespace?: { hidden: boolean; toggle: () => void } | undefined;
  /** The pull requests beside this one in the inbox it was opened from. */
  beside: Beside | null;
  /** Says, briefly, that a key found nothing to go to. */
  say?: (text: string) => void;
}): PageCommand[] {
  const { data, code } = page;
  if (!data) return [];
  const open = data.state !== "merged" && data.state !== "closed";
  const { url } = data;
  const to = (el: Element | null | undefined) => el?.scrollIntoView({ block: "start" });
  const none = (way: 1 | -1) => {
    const any = (code.current?.querySelectorAll(".finding-note").length ?? 0) > 0;
    page.say?.(
      !any
        ? "No open findings on this diff"
        : way === 1
          ? "No findings below"
          : "No findings above",
    );
  };
  return [
    ...(data.verdicts.length > 0 ? [{ label: "Review changes", key: "r", run: page.review }] : []),
    ...(page.ask ? [{ label: "Ask ocra a question", key: ASK_KEY, run: page.ask }] : []),
    { label: "Jump to code", key: "c", run: () => to(code.current) },
    { label: "Next file", key: "j", run: () => to(fileBeside(code.current, 1)) },
    { label: "Previous file", key: "k", run: () => to(fileBeside(code.current, -1)) },
    {
      label: "Next finding",
      key: "n",
      run: () => reach(findingBeside(code.current, 1), "center") || none(1),
    },
    {
      label: "Previous finding",
      key: "N",
      run: () => reach(findingBeside(code.current, -1), "center") || none(-1),
    },
    {
      label: "Toggle file viewed",
      key: "v",
      run: () => {
        const path = fileAtLine(code.current)?.dataset.path;
        if (path !== undefined) page.toggleViewed(path);
      },
    },
    ...(page.toggleConversation
      ? [{ label: "Show or hide the conversation", key: "t", run: page.toggleConversation }]
      : []),
    ...(page.switchLayout
      ? [
          {
            label: page.switchLayout.to === "split" ? "Show diffs split" : "Show diffs unified",
            run: page.switchLayout.run,
          },
        ]
      : []),
    ...(page.whitespace
      ? [
          {
            label: page.whitespace.hidden ? "Show whitespace changes" : "Hide whitespace changes",
            key: "w",
            run: page.whitespace.toggle,
          },
        ]
      : []),
    ...(open
      ? [
          {
            label: "Go to merge",
            key: "m",
            run: () => void reach(document.getElementById(MERGE_ID), "center"),
          },
        ]
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
    ...step("Previous pull request", "[", page.beside?.previous),
    ...step("Next pull request", "]", page.beside?.next),
  ];
}
