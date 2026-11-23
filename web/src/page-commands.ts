import { useEffect, useRef, useSyncExternalStore } from "react";

// What the open page can do, said once: each command is an entry in the
// command menu and the shortcuts list and, where it names a key, that key on
// the page. A page and the cards on it may each offer some; those under one
// title are listed together.

export type PageCommand = {
  label: string;
  /** One unmodified key that runs it while nothing is being typed. */
  key?: string;
  run: () => void;
};
type PageCommands = { title: string; commands: readonly PageCommand[] };

const offered = new Map<symbol, PageCommands>();
let current: readonly PageCommands[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  const byTitle = new Map<string, PageCommand[]>();
  for (const { title, commands } of offered.values()) {
    if (commands.length === 0) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), ...commands]);
  }
  current = [...byTitle].map(([title, commands]) => ({ title, commands }));
  for (const tell of listeners) tell();
}

const subscribe = (tell: () => void) => {
  listeners.add(tell);
  return () => listeners.delete(tell);
};

/** The open page's commands, by title, for the command menu and the shortcuts list. */
export const useOpenPageCommands = () => useSyncExternalStore(subscribe, () => current);

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** In a drawer, the command menu, a menu or a list box: their keys are their own. */
const inOverlay = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.closest("[role=dialog], [role=menu], [role=listbox]") !== null;

/** A key a page may take: no modifier but Shift, nothing typed, no overlay, not already used. */
export function pageKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (typing(e.target) || inOverlay(e.target)) return false;
  // Enter on a focused link or button is that control's own.
  return !(e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("a, button"));
}

/**
 * Offers commands while the component is mounted. `commands` may be made anew
 * on every render: the menu hears of a change only when their labels change.
 */
export function usePageCommands(title: string, commands: readonly PageCommand[]): void {
  const latest = useRef(commands);
  latest.current = commands;
  const shape = commands.map((c) => `${c.key ?? ""}\t${c.label}`).join("\n");
  useEffect(() => {
    const id = Symbol(title);
    const live = latest.current.map((c, i) => ({ ...c, run: () => latest.current[i]?.run() }));
    offered.set(id, { title, commands: shape === "" ? [] : live });
    publish();
    return () => {
      offered.delete(id);
      publish();
    };
  }, [title, shape]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageKey(e)) return;
      const command = latest.current.find((c) => c.key === e.key);
      if (!command) return;
      e.preventDefault();
      command.run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
