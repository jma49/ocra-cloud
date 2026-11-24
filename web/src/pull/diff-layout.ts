import { useState, useSyncExternalStore } from "react";
import type { DiffLayout } from "./diff-rows.js";

// How this browser draws diffs, kept between visits. A phone has no room for
// two columns of code, so below this width every diff is unified.

const KEY = "ocra-diff-layout";
const WRAP_KEY = "ocra-diff-wrap";
const NARROW = "(max-width: 760px)";

function read(): DiffLayout {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = matchMedia(NARROW);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => matchMedia(NARROW).matches,
  );
}

/** The layout picked, the one drawn (unified on a phone), and a way to pick. */
export function useDiffLayout() {
  const [picked, setPicked] = useState(read);
  const narrow = useNarrow();
  const pick = (layout: DiffLayout) => {
    setPicked(layout);
    try {
      localStorage.setItem(KEY, layout);
    } catch {}
  };
  return { picked, drawn: narrow ? ("unified" as const) : picked, narrow, pick };
}

/** Whether long lines wrap (the default) or run on, the diff scrolling sideways; a phone always wraps. */
export function useDiffWrap(narrow: boolean) {
  const [picked, setPicked] = useState(() => {
    try {
      return localStorage.getItem(WRAP_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const pick = (wrap: boolean) => {
    setPicked(wrap);
    try {
      localStorage.setItem(WRAP_KEY, wrap ? "on" : "off");
    } catch {}
  };
  return { picked, drawn: narrow || picked, pick };
}
