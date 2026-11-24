import type { StatusTone } from "@/components/status";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { PullPeopleView } from "../../../src/shared/index.js";
import { PersonMark } from "../person-mark.js";
import { REVIEWER_STATE, REVIEWERS_ID } from "./people.js";

// The pull request's reviewers on its head's line: up to three marks, then how
// many more, where each stands named in a tooltip and for a screen reader; a
// press leads to the rail's reviewers.

const SHOWN = 3;

type Reviewer = { name: string; state: string; tone: StatusTone };

const reviewersOf = (view: PullPeopleView): Reviewer[] => [
  ...view.reviewers.map((r) => {
    const { text, tone } = REVIEWER_STATE[r.state];
    return { name: r.login, state: text, tone };
  }),
  ...view.teams.map((t) => ({ name: t.name, state: "Team asked", tone: "quiet" as const })),
];

/** Brings the rail's reviewers into view and puts the keys there. */
function showReviewers() {
  const section = document.getElementById(REVIEWERS_ID);
  section?.scrollIntoView({ block: "center" });
  section?.focus({ preventScroll: true });
}

export function ReviewerStack(props: { view: PullPeopleView | undefined }) {
  const people = props.view?.reviewers ? reviewersOf(props.view) : [];
  if (people.length === 0) return null;
  const label = `Reviewers: ${people.map((p) => `${p.name}, ${p.state.toLowerCase()}`).join("; ")}`;
  const more = people.length - SHOWN;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="reviewer-stack"
            aria-label={label}
            onClick={showReviewers}
          />
        }
      >
        <span className="reviewer-marks">
          {people.slice(0, SHOWN).map((p) => (
            <span key={p.name} className={`reviewer-mark is-${p.tone}`}>
              <PersonMark login={p.name} />
            </span>
          ))}
        </span>
        {more > 0 && <span className="reviewer-more">+{more}</span>}
      </TooltipTrigger>
      <TooltipPopup>
        <ul className="reviewer-tip">
          {people.map((p) => (
            <li key={p.name}>
              {p.name}
              <span className="reviewer-tip-state">{p.state}</span>
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}
