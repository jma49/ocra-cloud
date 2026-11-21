import { useState } from "react";
import type { SectionId } from "./sections.js";

const KEY = "ocra-inbox-collapsed";

function read(): Set<SectionId> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as SectionId[]);
  } catch {
    return new Set();
  }
}

/** Which sections this browser keeps folded. */
export function useCollapsed() {
  const [collapsed, set] = useState(read);
  const toggle = (id: SectionId) =>
    set((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { collapsed, toggle };
}
