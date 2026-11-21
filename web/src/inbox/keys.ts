import { useEffect, useRef } from "react";

type Keys = {
  move: (step: 1 | -1) => void;
  open: () => void;
  find: () => void;
  refresh: () => void;
};

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** j/k move, Enter or o opens, / finds, r refreshes; never while typing. */
export function useListKeys(keys: Keys) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = latest.current;
      if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("a, button")) {
        return;
      }
      const act = {
        j: () => k.move(1),
        k: () => k.move(-1),
        Enter: k.open,
        o: k.open,
        "/": k.find,
        r: k.refresh,
      }[e.key];
      if (!act) return;
      e.preventDefault();
      act();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
