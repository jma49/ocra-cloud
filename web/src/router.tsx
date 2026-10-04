import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

// A few pages need no router library: paths on the History API, served by
// the Worker's single-page fallback.

const listeners = new Set<() => void>();

function navigate(to: string): void {
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

export function Link(props: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(props.to);
  };
  return (
    <a href={props.to} className={props.className} onClick={onClick}>
      {props.children}
    </a>
  );
}
