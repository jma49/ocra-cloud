import type { ReviewTraceView } from "../../../src/shared/index.js";
import { useRead } from "../cache.js";
import { TraceCard } from "../trace/trace-card.js";
import { LoadError } from "../ui.js";

// The review's trace, read once its page knows it kept one. It can be large,
// so it stays out of the browser's store.

export function ReviewTrace(props: { id: string; runId: string }) {
  const { data, error, reload } = useRead<{ trace: ReviewTraceView }>(
    `/reviews/${encodeURIComponent(props.id)}/trace`,
    { memoryOnly: true },
  );
  if (error) {
    return (
      <div className="card walkthrough">
        <LoadError what="the trace" error={error} retry={reload} inCard />
      </div>
    );
  }
  return data ? <TraceCard trace={data.trace} runId={props.runId} /> : null;
}
