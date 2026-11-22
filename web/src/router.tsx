import { type ComponentProps, type MouseEvent, type ReactNode, useEffect, useState } from "react";

// A few pages need no router library: paths on the History API, served by
// the Worker's single-page fallback.

const listeners = new Set<() => void>();

export function navigate(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  for (const l of listeners) l();
  window.scrollTo(0, 0);
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
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
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
