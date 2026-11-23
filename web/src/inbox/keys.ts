import { useEffect, useRef } from "react";
import { typing } from "../page-commands.js";

type Keys = {
  move: (step: 1 | -1) => void;
  open: () => void;
  openOnPlatform: () => void;
  find: () => void;
  refresh: () => void;
  toggleRead: () => void;
};

/** j/k move, Enter opens here, o on the platform, / finds, r refreshes, u marks read or unread; never while typing. */
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
        o: k.openOnPlatform,
        "/": k.find,
        r: k.refresh,
        u: k.toggleRead,
      }[e.key];
      if (!act) return;
      e.preventDefault();
      act();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
