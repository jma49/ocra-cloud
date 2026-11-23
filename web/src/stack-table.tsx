import { type ReactNode, useLayoutEffect, useRef } from "react";

/** A table that turns its rows into blocks when its card is too narrow to hold it as a table. */
export function StackTable(props: { children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    const table = el?.querySelector("table");
    if (!el || !table || typeof ResizeObserver === "undefined") return;
    // Stacked, the table fits any width, so the width it needs as a table is
    // the one it last overflowed with.
    let needs = 0;
    const fit = () => {
      if (el.hasAttribute("data-stacked")) {
        if (el.clientWidth >= needs) el.removeAttribute("data-stacked");
      } else if (table.offsetWidth > el.clientWidth) {
        needs = table.offsetWidth;
        el.setAttribute("data-stacked", "");
      }
    };
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    watch.observe(table);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="table-wrap stack" ref={wrap}>
      {props.children}
    </div>
  );
}
