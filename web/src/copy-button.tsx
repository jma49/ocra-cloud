import Check from "lucide-react/icons/check";
import Copy from "lucide-react/icons/copy";
import { type ComponentProps, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const SHOWN_MS = 1600;

/** Copies `text` and says so in place: its icon turns into a check for a moment. */
export function CopyButton(props: {
  text: string | (() => string);
  label?: string;
  /** What a screen reader hears once it is copied. */
  said?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const text = typeof props.text === "function" ? props.text() : props.text;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const Mark = copied ? Check : Copy;
  return (
    <>
      <Button
        type="button"
        variant={props.variant ?? "outline"}
        {...(props.size ? { size: props.size } : {})}
        onClick={copy}
      >
        <Mark key={copied ? "done" : "copy"} className="copy-mark" size={14} aria-hidden="true" />
        {props.label ?? "Copy"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? (props.said ?? "Copied") : ""}
      </span>
    </>
  );
}
