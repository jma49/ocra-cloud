import { useEffect, useRef } from "react";
import { pageKey } from "../page-commands.js";
import { navigate } from "../router.js";
import { type Place, placeHome } from "../routes.js";

// Keys that hold on every page: "?" lists the shortcuts, and "g" then a
// place's letter goes there.

export const GO_TO: readonly { key: string; place: Place; label: string }[] = [
  { key: "i", place: "inbox", label: "Inbox" },
  { key: "r", place: "reviews", label: "Reviews" },
  { key: "f", place: "findings", label: "Findings" },
  { key: "p", place: "repositories", label: "Repositories" },
  { key: "n", place: "insights", label: "Insights" },
  { key: "s", place: "settings", label: "Settings" },
];

/** How long after "g" its second key still counts. */
const CHORD_MS = 1200;

export function useGlobalKeys(showShortcuts: () => void): void {
  const show = useRef(showShortcuts);
  show.current = showShortcuts;
  useEffect(() => {
    let since = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!pageKey(e)) return;
      const chord = Date.now() - since < CHORD_MS;
      since = 0;
      if (chord) {
        const go = GO_TO.find((g) => g.key === e.key);
        if (!go) return;
        e.preventDefault();
        navigate(placeHome(go.place));
      } else if (e.key === "g") {
        since = Date.now();
      } else if (e.key === "?") {
        e.preventDefault();
        show.current();
      }
    };
    // In the capture phase, so the second key of "g i" is not also a page's own key.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
