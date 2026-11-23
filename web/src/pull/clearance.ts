import { useEffect } from "react";

const CLEAR = "--pull-clear";

/**
 * How far below the window's top a scrolled-to part must stop to clear the
 * page's sticky head, whose height follows its title's lines.
 */
export function useClearance(head: HTMLElement | null): void {
  useEffect(() => {
    if (!head) return;
    const root = document.documentElement;
    const measure = () => {
      // A narrow window lets the head scroll away: then only the page bar stays.
      const stays =
        getComputedStyle(head).position === "sticky"
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
