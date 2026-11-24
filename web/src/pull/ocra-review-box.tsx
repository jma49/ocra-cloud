import type { ReactNode } from "react";
import { Status } from "@/components/status";
import type { PullDescriptionDraftView } from "../../../src/shared/index.js";
import { ago, count } from "../format.js";
import { Link } from "../router.js";

// Where ocra's review of this pull request stands, and the way into it: the
// review of the head on the page when there is one, else the newest.

export function OcraReviewBox(props: {
  /** The stored review, as the description's draft names it; undefined until read. */
  review: PullDescriptionDraftView["review"] | undefined;
  /** Its open findings drawn on the diff below. */
  open?: number;
  /** What the server's own runner adds: its queue's state and "Review now". */
  children?: ReactNode;
  /** Open findings of earlier heads, folded. */
  earlier?: ReactNode;
}) {
  const { review } = props;
  if (review === undefined) return null;
  const unfinished = review?.current === true && !review.complete;
  const standing = !review?.current
    ? { text: "Out of date", tone: "quiet" as const }
    : unfinished
      ? { text: "Incomplete", tone: "warn" as const }
      : { text: "Reviewed", tone: "ok" as const };
  return (
    <section className="card card-pad stack" aria-label="ocra review">
      <div className="row-gap checks-head">
        <h2 className="card-title grow">ocra review</h2>
        {review && <Status tone={standing.tone}>{standing.text}</Status>}
      </div>
      {review && unfinished && (
        <span className="subtle small">
          The review of this head {ago(review.createdAt)} left files unreviewed, so it is not a
          pass.
        </span>
      )}
      {review && !unfinished && !props.children && (
        <span className="subtle small">
          {review.current
            ? `ocra reviewed this head ${ago(review.createdAt)}.`
            : `The newest review is of ${review.head.slice(0, 7)}, before the latest commits.`}
        </span>
      )}
      {!review && !props.children && (
        <span className="subtle small">
          Not reviewed yet. A review shows here once <span className="mono">ocra review</span> runs
          on this pull request, in CI or from the CLI.
        </span>
      )}
      {props.children}
      {review?.current && props.open !== undefined && props.open > 0 && (
        <span className="small">{count(props.open, "open finding")} on the diff below.</span>
      )}
      {props.earlier}
      {review && (
        <Link to={`/reviews/${review.id}`} className="status-link">
          Open the review
        </Link>
      )}
    </section>
  );
}
