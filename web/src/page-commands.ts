import { useEffect, useRef, useSyncExternalStore } from "react";

// What the open page can do, said once: each command is an entry in the
// command menu and, where it names a key, that key on the page.

export type PageCommand = {
  label: string;
  /** One unmodified key that runs it while nothing is being typed. */
  key?: string;
  run: () => void;
};
type PageCommands = { title: string; commands: readonly PageCommand[] };

let current: PageCommands | null = null;
const listeners = new Set<() => void>();

function publish(next: PageCommands | null): void {
  current = next;
  for (const tell of listeners) tell();
}

const subscribe = (tell: () => void) => {
  listeners.add(tell);
  return () => listeners.delete(tell);
};

/** The open page's commands, for the command menu. */
export const useOpenPageCommands = () => useSyncExternalStore(subscribe, () => current);

export const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const inDialog = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.closest("[role=dialog]") !== null;

/**
 * Offers a page's commands while it is open. `commands` may be made anew on
 * every render: the menu hears of a change only when their labels change.
 */
export function usePageCommands(title: string, commands: readonly PageCommand[]): void {
  const latest = useRef(commands);
  latest.current = commands;
  const shape = commands.map((c) => `${c.key ?? ""}\t${c.label}`).join("\n");
  useEffect(() => {
    const live = latest.current.map((c, i) => ({ ...c, run: () => latest.current[i]?.run() }));
    const mine = { title, commands: shape === "" ? [] : live };
    publish(mine);
    return () => {
      if (current === mine) publish(null);
    };
  }, [title, shape]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || inDialog(e.target)) return;
      const command = latest.current.find((c) => c.key === e.key);
      if (!command) return;
      e.preventDefault();
      command.run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
