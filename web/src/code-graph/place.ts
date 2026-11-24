import { useEffect, useState } from "react";

// Where the explorer stands, kept in the address so Back steps out of a
// focus and a link opens the same view: a folder's map, a file or a symbol,
// or a pull request's impact.

export type GraphPlace =
  | { view: "map"; folder: string }
  | { view: "focus"; path: string; symbol?: { name: string; line?: number } }
  | { view: "impact"; pull: number };

function placeOf(search: string): GraphPlace {
  const q = new URLSearchParams(search);
  const pull = Number(q.get("pull"));
  if (Number.isInteger(pull) && pull > 0) return { view: "impact", pull };
  const path = q.get("file");
  if (path) {
    const name = q.get("symbol");
    const line = Number(q.get("line"));
    if (!name) return { view: "focus", path };
    return {
      view: "focus",
      path,
      symbol: Number.isInteger(line) && line > 0 ? { name, line } : { name },
    };
  }
  return { view: "map", folder: q.get("in") ?? "" };
}

function searchOf(place: GraphPlace): string {
  const q = new URLSearchParams();
  if (place.view === "impact") q.set("pull", String(place.pull));
  else if (place.view === "focus") {
    q.set("file", place.path);
    if (place.symbol) {
      q.set("symbol", place.symbol.name);
      if (place.symbol.line) q.set("line", String(place.symbol.line));
    }
  } else if (place.folder) q.set("in", place.folder);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The explorer's address for a repository's graph at a place. */
export const graphPath = (repo: string, place?: GraphPlace) =>
  `/code-graphs/${encodeURIComponent(repo)}${place ? searchOf(place) : ""}`;

/** The place in the address, and a step to another that Back undoes. */
export function useGraphPlace(): [GraphPlace, (to: GraphPlace) => void] {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const update = () => setSearch(location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const go = (to: GraphPlace) => {
    const next = searchOf(to);
    if (next === location.search) return;
    history.pushState(null, "", `${location.pathname}${next}`);
    setSearch(next);
  };
  return [placeOf(search), go];
}
