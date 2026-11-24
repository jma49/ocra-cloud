import { type RefObject, useEffect, useRef, useState } from "react";
import type { ShownSection } from "./sections.js";

// While the pointer is over the list, a refresh keeps each row where it was,
// so the row about to be clicked does not slide away. Rows still change their
// contents at once; the new order lands when the pointer leaves.

const idOf = (r: ShownSection["rows"][number]) => `${r.host}:${r.id}`;

/** `next`'s rows in the order `before` showed them: rows it lacks go last, rows gone are dropped. */
export function holdOrder(before: ShownSection[], next: ShownSection[]): ShownSection[] {
  const placed = new Map(before.map((s) => [s.key, new Map(s.rows.map((r, i) => [idOf(r), i]))]));
  return next.map((s) => {
    const at = placed.get(s.key);
    if (!at) return s;
    const rank = (r: ShownSection["rows"][number]) => at.get(idOf(r)) ?? Number.MAX_SAFE_INTEGER;
    return {
      ...s,
      rows: s.rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
        .map((x) => x.r),
    };
  });
}

function usePointerIn(list: RefObject<HTMLElement | null>): boolean {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const enter = () => setInside(true);
    const leave = () => setInside(false);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  });
  return inside;
}

/** The sections to draw: `sections`, in the order last shown while the pointer is over `list`. */
export function useHeldOrder(
  sections: ShownSection[],
  list: RefObject<HTMLElement | null>,
): ShownSection[] {
  const inside = usePointerIn(list);
  const shown = useRef(sections);
  shown.current = inside ? holdOrder(shown.current, sections) : sections;
  return shown.current;
}
