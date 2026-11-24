import { useEffect } from "react";

const CLEAR = "--pull-clear";

/**
 * How far below the window's top a scrolled-to part must stop to clear what
 * stays in view over it: the line that stands for the head, or on a phone,
 * where there is none, the page bar.
 */
export function useClearance(head: HTMLElement | null): void {
  useEffect(() => {
    if (!head) return;
    const root = document.documentElement;
    const measure = () => {
      const style = getComputedStyle(head);
      const stays =
        style.position === "sticky" && style.display !== "none"
          ? head
          : document.querySelector<HTMLElement>(".pagebar");
      const bottom = stays ? stuckBottom(stays) : 0;
      root.style.setProperty(CLEAR, `${Math.ceil(bottom) + 12}px`);
    };
    measure();
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(head);
    return () => {
      watch?.disconnect();
      root.style.removeProperty(CLEAR);
    };
  }, [head]);
}

const stuckBottom = (el: HTMLElement) =>
  (Number.parseFloat(getComputedStyle(el).top) || 0) + el.offsetHeight;
