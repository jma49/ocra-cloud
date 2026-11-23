import type { MergeQueueView, QueueEntry, QueueState } from "../../../src/shared/index.js";
import { ago, count } from "../format.js";

// A merge queue entry in words: where it is, what happens to it there, and
// how it last left.

export const QUEUE_STATE: Record<QueueState, { label: string; tone: string; says: string }> = {
  waiting: {
    label: "Queued",
    tone: "badge",
    says: "Waiting for the pull requests ahead of it.",
  },
  checking: {
    label: "Checks running",
    tone: "badge badge-run",
    says: "The queue is running the checks on it as it would land.",
  },
  ready: {
    label: "Next to merge",
    tone: "badge badge-ok",
    says: "Its checks passed in the queue. It merges once the ones ahead have.",
  },
  merging: { label: "Merging", tone: "badge badge-run", says: "The queue is merging it now." },
  blocked: {
    label: "Cannot merge",
    tone: "badge badge-err",
    says: "It cannot merge as queued, so the queue will drop it. Look at its checks and conflicts, then add it again.",
  },
};

/** With nothing ahead of it there are no others to wait for. */
const FIRST: Partial<Record<QueueState, string>> = {
  waiting: "Waiting for the queue to start on it.",
  ready: "Its checks passed in the queue. It merges next.",
};

/** What happens to an entry in its state, said for its place in the line. */
export const queueSays = (entry: QueueEntry): string =>
  (entry.position === 1 && FIRST[entry.state]) || QUEUE_STATE[entry.state].says;

const ordinal = (n: number) => {
  const tens = n % 100;
  const ending = tens > 10 && tens < 14 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${ending}`;
};

/** In the console's own short units, as `ago` writes them. */
function estimate(seconds: number): string {
  if (seconds < 90) return "merges in about 1m";
  if (seconds < 5400) return `merges in about ${Math.round(seconds / 60)}m`;
  return `merges in about ${Math.round(seconds / 3600)}h`;
}

/** What is known of an entry's place, in the order a reader asks: where, when it merges, since when. */
export function queuePlace(entry: QueueEntry, size: number | null): string[] {
  const where =
    entry.position === null
      ? []
      : [
          size === null
            ? `${ordinal(entry.position)} in line`
            : `${ordinal(entry.position)} of ${size}`,
        ];
  const when = entry.estimate === null ? [] : [estimate(entry.estimate)];
  const by = entry.enqueuedBy ? ` by ${entry.enqueuedBy}` : "";
  const since = entry.enqueuedAt ? [`queued ${ago(entry.enqueuedAt)}${by}`] : [];
  return [...where, ...when, ...since];
}

/** How the pull request last left the queue, the platform's reason said as it gave it. */
export function queueRemoval(removed: NonNullable<MergeQueueView["removed"]>): string {
  const reason = removed.reason?.replace(/[.\s]+$/, "");
  if (reason) return `Left the queue ${ago(removed.at)}: ${reason}.`;
  return removed.by
    ? `${removed.by} took it out of the queue ${ago(removed.at)}.`
    : `Left the queue ${ago(removed.at)}.`;
}

export const queueSize = (size: number) =>
  size === 0 ? "The queue is empty now." : `${count(size, "pull request")} in the queue now.`;
