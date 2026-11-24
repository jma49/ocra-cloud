import type {
  ReleasePullView,
  ReleaseReviewVerdict,
  ReleaseSection,
} from "../../../src/shared/index.js";
import { RELEASE_SECTIONS } from "../../../src/shared/index.js";

// The pull requests of a release's range, under the section each one's
// title put it in.

const SECTION_LABEL: Record<ReleaseSection, string> = {
  breaking: "Breaking changes",
  added: "Added",
  fixed: "Fixed",
  performance: "Performance",
  other: "Other changes",
  hidden: "Maintenance",
};
const VERDICT: Record<ReleaseReviewVerdict, { label: string; tone: string }> = {
  approved: { label: "Approved", tone: "badge badge-ok" },
  approved_with_comments: { label: "Approved with comments", tone: "badge badge-ok" },
  minor_issues: { label: "Minor issues", tone: "badge badge-warn" },
  significant_concerns: { label: "Significant concerns", tone: "badge badge-err" },
};

export function ReleasePulls(props: {
  pulls: ReleasePullView[];
  /** "#" or "!", as the platform writes a pull request's number. */
  marker: string;
  showHidden: boolean;
}) {
  const sections = RELEASE_SECTIONS.filter((s) => s !== "hidden" || props.showHidden)
    .map((s) => ({ id: s, pulls: props.pulls.filter((p) => p.section === s) }))
    .filter((s) => s.pulls.length > 0);
  const left = props.showHidden ? 0 : props.pulls.filter((p) => p.section === "hidden").length;
  return (
    <div className="release-pulls">
      {sections.map((s) => (
        <section key={s.id} aria-label={SECTION_LABEL[s.id]}>
          <h2 className="quiet-label">
            {SECTION_LABEL[s.id]} <span className="subtle">{s.pulls.length}</span>
          </h2>
          <ul>
            {s.pulls.map((p) => (
              <li key={p.number}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {props.marker}
                  {p.number}
                </a>
                <span className="grow">{p.title}</span>
                {p.review?.verdict && (
                  <span className={VERDICT[p.review.verdict].tone}>
                    {VERDICT[p.review.verdict].label}
                  </span>
                )}
                {p.author && <span className="subtle small hide-narrow">{p.author}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {left > 0 && (
        <p className="subtle small m-0">
          {left} maintenance {left === 1 ? "change is" : "changes are"} left out. Tick Maintenance
          changes and draft again to list {left === 1 ? "it" : "them"}.
        </p>
      )}
    </div>
  );
}
