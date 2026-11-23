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
      const top = Number.parseFloat(getComputedStyle(head).top) || 0;
      root.style.setProperty(CLEAR, `${Math.ceil(top + head.offsetHeight) + 12}px`);
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
