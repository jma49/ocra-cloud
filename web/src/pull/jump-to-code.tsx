import ArrowDown from "lucide-react/icons/arrow-down";
import { type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A way past the description to the diff, shown while the diff is still
 * below the window. An observer says so, never a scroll listener.
 */
export function JumpToCode(props: { target: RefObject<HTMLElement | null> }) {
  const { target } = props;
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(([entry]) => {
      if (entry) setBelow(!entry.isIntersecting && entry.boundingClientRect.top > 0);
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [target]);
  if (!below) return null;
  return (
    <div className="jump-to-code">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => target.current?.scrollIntoView({ block: "start" })}
      >
        Jump to code
        <ArrowDown size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
