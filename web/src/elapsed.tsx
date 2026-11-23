import { useEffect, useState } from "react";
import { elapsed } from "./format.js";

export function Elapsed(props: { since: number | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (props.since === undefined) return null;
  return (
    <span className="elapsed" aria-hidden="true">
      {elapsed(now - props.since)}
    </span>
  );
}
