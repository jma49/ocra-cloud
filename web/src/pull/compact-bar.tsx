import { type ReactNode, useEffect, useState } from "react";

// Once the pull request's head has scrolled away, one line takes its place
// under the page bar: its number, title, standing and next step, so the diff
// gets the window and the next step stays in reach.

/** Whether `head` has gone up past the page bar. */
function useScrolledPast(head: HTMLElement | null): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!head || typeof IntersectionObserver === "undefined") return;
    const pagebar = document.querySelector<HTMLElement>(".pagebar");
    const top = pagebar ? pagebar.getBoundingClientRect().bottom : 0;
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < top);
      },
      { rootMargin: `-${Math.round(top)}px 0px 0px 0px` },
    );
    watch.observe(head);
    return () => watch.disconnect();
  }, [head]);
  return past;
}

export function CompactBar(props: {
  head: HTMLElement | null;
  number: string;
  title: string;
  status: ReactNode;
  actions: ReactNode;
  onAnchor: (el: HTMLElement | null) => void;
}) {
  const shown = useScrolledPast(props.head);
  return (
    <div className="pull-bar-anchor" ref={props.onAnchor}>
      {shown && (
        <div className="pull-bar">
          <span className="pull-bar-title">
            <span className="pull-bar-number">#{props.number}</span>
            {props.title}
          </span>
          <span className="pull-bar-status">{props.status}</span>
          <div className="pull-actions">{props.actions}</div>
        </div>
      )}
    </div>
  );
}
