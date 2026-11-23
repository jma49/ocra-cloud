import type { ReactNode } from "react";
import type { PullDescriptionDraftView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { Link } from "../router.js";

// Where ocra's review of this pull request stands, and the way into it: the
// review of the head on the page when there is one, else the newest.

export function OcraReviewBox(props: {
  /** The stored review, as the description's draft names it; undefined until read. */
  review: PullDescriptionDraftView["review"] | undefined;
  /** What the server's own runner adds: its queue's state and "Review now". */
  children?: ReactNode;
}) {
  const { review } = props;
  if (review === undefined) return null;
  return (
    <section className="card card-pad stack" aria-label="ocra review">
      <div className="row-gap checks-head">
        <span className="strong grow">ocra review</span>
        {review && (
          <span className={review.current ? "badge badge-ok" : "badge"}>
            {review.current ? "Reviewed" : "Out of date"}
          </span>
        )}
      </div>
      {review && !props.children && (
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
      {review && (
        <Link to={`/reviews/${review.id}`} className="rail-link">
          Open the review
        </Link>
      )}
    </section>
  );
}
