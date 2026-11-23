import type { Row, Scoped } from "./db/scoped.js";
import type { PlatformDismissal } from "./shared/index.js";

// What people did on the platform to the threads of a review's findings
// (src/auto-review/finding-threads.ts), by fingerprint: a finding commented
// in several threads of its pull request shows the one acted on last.

type Thread = Row<"findingThreads">;

const iso = (at: Date | null) => at?.toISOString() ?? null;
const actedAt = (t: Thread) => Math.max(t.stateAt?.getTime() ?? 0, t.reasonAt?.getTime() ?? 0);

const dismissalDto = (t: Thread) =>
  ({
    state: t.state,
    by: t.stateBy,
    at: iso(t.stateAt),
    reason: t.reason,
    reasonBy: t.reasonBy,
    reasonAt: iso(t.reasonAt),
    redacted: t.reasonRedacted,
    truncated: t.reasonTruncated,
  }) satisfies PlatformDismissal;

/** The platform dismissals of the review's pull request, by finding fingerprint; none for another review. */
export async function platformDismissals(
  data: Scoped,
  review: Pick<Row<"reviews">, "prRepository" | "prNumber">,
): Promise<Map<string, PlatformDismissal>> {
  const newest = new Map<string, Thread>();
  if (!review.prRepository || !review.prNumber) return new Map();
  for (const t of await data.findingThreads.ofPull(review.prRepository, review.prNumber)) {
    const kept = newest.get(t.fingerprint);
    if (!kept || actedAt(t) > actedAt(kept)) newest.set(t.fingerprint, t);
  }
  return new Map([...newest].map(([fingerprint, t]) => [fingerprint, dismissalDto(t)]));
}
