import {
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

// A few pages need no router library: paths on the History API, served by
// the Worker's single-page fallback.

const listeners = new Set<() => void>();

export type Intent = "hover" | "open";
let readyFor: (to: string, intent: Intent) => void = () => {};

/** What gets a page ready when a link to it is hovered or opened (the signed-in console sets it). */
export function prepareWith(ready: (to: string, intent: Intent) => void): void {
  readyFor = ready;
}

/** Gets the page at `to` ready, as a hover or an open would. */
export function prepare(to: string, intent: Intent): void {
  readyFor(to, intent);
}

export function navigate(to: string): void {
  if (to === location.pathname) return;
  readyFor(to, "open");
  history.pushState(null, "", to);
  for (const l of listeners) l();
  window.scrollTo(0, 0);
}

/** A query parameter of the address the page opened at: a link's filter, read once as the page mounts. */
export const searchParam = (name: string): string | null =>
  new URLSearchParams(location.search).get(name);

/** The `days` a link asked for, when the page offers that range. */
export function daysParam(offered: readonly { value: number }[], fallback: number): number {
  const asked = Number(searchParam("days"));
  return offered.some((o) => o.value === asked) ? asked : fallback;
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

// A pointer resting this long on a link is likely to click it; one passing
// over it on its way elsewhere is not.
const HOVER_MS = 60;

/** Handlers that get the page at `to` ready as a pointer rests on, presses or focuses its link. */
export function useIntent(to: string) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      cancel();
      timer.current = setTimeout(() => readyFor(to, "hover"), HOVER_MS);
    },
    onPointerLeave: cancel,
    onPointerDown: (e: PointerEvent) => {
      if (e.button === 0) readyFor(to, "open");
    },
    onFocus: () => readyFor(to, "hover"),
  };
}

/** Other anchor props (a coss Button's, when it renders a Link) pass through. */
export function Link({
  to,
  current,
  label,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href"> & {
  to: string;
  /** The open page: announced as such. */
  current?: boolean;
  /** The accessible name, for a link that shows only an icon. */
  label?: string;
  children?: ReactNode;
}) {
  const intent = useIntent(to);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
      {...intent}
      {...rest}
      href={to}
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      aria-label={label}
    >
      {children}
    </a>
  );
}
