import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

// A run of a diff's rows, drawn only while it is near the window. Away from
// it the run is one empty row of the height it last had (or an estimate),
// so the page keeps its length and the scroll bar does not jump. One shared
// observer watches every run: no scroll listener.

/** How far beyond the window a run is drawn ahead of being scrolled to. */
const AHEAD = "1600px 0px";

type Seen = (near: boolean) => void;
const watched = new Map<Element, Seen>();
let observer: IntersectionObserver | undefined;

/** Calls `seen` as the element comes near the window and goes from it. */
export function watchNear(el: Element, seen: Seen): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) watched.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: AHEAD },
  );
  watched.set(el, seen);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}

export function LazyBody(props: {
  /** The height to hold before the run was ever drawn. */
  estimate: number;
  /** Keeps the run drawn, as while it holds a comment being written. */
  pinned: boolean;
  columns: number;
  children: () => ReactNode;
}) {
  const ref = useRef<HTMLTableSectionElement>(null);
  const height = useRef<number | null>(null);
  const [near, setNear] = useState(false);
  const [focused, setFocused] = useState(false);
  const drawn = near || props.pinned || focused;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watchNear(el, (now) => {
      // What it measured while drawn is the height it holds once it is not.
      if (!now && el.firstElementChild?.className !== "diff-gap")
        height.current = el.getBoundingClientRect().height;
      setNear(now);
    });
  }, []);
  useLayoutEffect(() => {
    if (drawn && ref.current) height.current = ref.current.getBoundingClientRect().height;
  });
  return (
    <tbody
      ref={ref}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {drawn ? (
        props.children()
      ) : (
        <tr className="diff-gap">
          <td colSpan={props.columns} style={{ height: height.current ?? props.estimate }} />
        </tr>
      )}
    </tbody>
  );
}
