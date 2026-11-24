import Flag from "lucide-react/icons/flag";
import type { PullFindingsView, PullFindingView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { FixWithOcra } from "../fixes/fix-with-ocra.js";
import { Markdown } from "../markdown.js";
import { Link } from "../router.js";
import { SeverityBadge } from "../severity.js";
import { useLoad } from "../ui.js";
import { FindingDecide } from "./finding-decide.js";

// ocra's open findings on the pull request's diff: each under the line it
// ends on, with what the reviewer wrote and the way into the review.

const NONE: PullFindingsView = { review: null, findings: [] };

/** The findings the API path answers; none while loading, or when they could not be read. */
export function usePullFindings(path: string | null): PullFindingsView & { reload: () => void } {
  const { data, reload } = useLoad(
    () => (path ? api<PullFindingsView>(path) : Promise.resolve(null)),
    [path],
  );
  return { ...(data?.findings ? data : NONE), reload };
}

/** The new line a finding goes under: where its range ends; none for one about the whole file. */
export const underLine = (f: PullFindingView) => ({
  ...f,
  endLine: f.lineEnd ?? f.lineStart ?? -1,
});

export function FindingNote(props: {
  finding: PullFindingView;
  onDecided: (decided: boolean) => void;
}) {
  const { finding: f } = props;
  return (
    <section className="fix-proposal finding-note" aria-label={`ocra's finding: ${f.title}`}>
      <div className="fix-proposal-head">
        <Flag size={16} aria-hidden="true" />
        <SeverityBadge severity={f.severity} />
        <span className="fix-proposal-title strong">{f.title}</span>
        <Link to={`/reviews/${f.review}`}>Open in the review</Link>
      </div>
      <div className="finding-note-body">
        <Markdown text={f.body} />
      </div>
      <FindingDecide finding={f} onDecided={props.onDecided}>
        <FixWithOcra finding={f} />
      </FindingDecide>
    </section>
  );
}
