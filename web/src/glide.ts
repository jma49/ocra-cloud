import { type RefObject, useEffect, useLayoutEffect } from "react";

// One highlight per container (`.glide`, motion.css) that moves to an item
// instead of each item drawing its own: under the pointer, or on the picked one.

function place(box: HTMLElement, item: Element | null | undefined) {
  if (!(item instanceof HTMLElement)) {
    box.dataset.glide = "off";
    return;
  }
  // A highlight that was hidden appears on the item; it only glides between items.
  const appearing = box.dataset.glide !== "on";
  if (appearing) box.dataset.glide = "jump";
  box.style.setProperty("--glide-x", `${item.offsetLeft}px`);
  box.style.setProperty("--glide-y", `${item.offsetTop}px`);
  box.style.setProperty("--glide-w", `${item.offsetWidth}px`);
  box.style.setProperty("--glide-h", `${item.offsetHeight}px`);
  if (appearing) void box.offsetWidth;
  box.dataset.glide = "on";
}

/** The highlight follows a mouse over the items matching `selector`. */
export function useHoverGlide(ref: RefObject<HTMLElement | null>, selector: string) {
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !(e.target instanceof Element)) return;
      const item = e.target.closest(selector);
      if (item && box.contains(item)) place(box, item);
    };
    const leave = () => place(box, null);
    box.addEventListener("pointerover", over);
    box.addEventListener("pointerleave", leave);
    return () => {
      box.removeEventListener("pointerover", over);
      box.removeEventListener("pointerleave", leave);
    };
  }, [ref, selector]);
}

/** The highlight sits on the item matching `selector`, and moves when another one does. */
export function usePickedGlide(ref: RefObject<HTMLElement | null>, selector: string) {
  // After every render: which item is picked is the caller's state, not this hook's.
  useLayoutEffect(() => {
    const box = ref.current;
    if (box) place(box, box.querySelector(selector));
  });
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => place(box, box.querySelector(selector)));
    watch.observe(box);
    return () => watch.disconnect();
  }, [ref, selector]);
}
