import { useState } from "react";

const KEY = "ocra-inbox-collapsed";

function read(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Which sections this browser keeps folded. */
export function useCollapsed() {
  const [collapsed, set] = useState(read);
  const toggle = (key: string) =>
    set((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { collapsed, toggle };
}
