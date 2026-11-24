import X from "lucide-react/icons/x";
import { useState } from "react";
import { Status, type StatusTone } from "@/components/status";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  PullActionOutcome,
  PullPeopleRequest,
  PullPeopleView,
  ReviewerState,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction, useLoad } from "../ui.js";
import { OUTCOME } from "./outcome.js";
import { PeoplePicker } from "./people-picker.js";

// Who the pull request asks for a review and who it is assigned to, read
// live and changed as the user: one person at a time, then read again,
// since the platform answers a partly refused change as refused.

type Ref = { platform: CodePlatformKind; repo: string; number: number };
type List = "reviewers" | "assignees";

const STATE: Record<ReviewerState, { text: string; tone: StatusTone }> = {
  requested: { text: "Asked", tone: "quiet" },
  approved: { text: "Approved", tone: "ok" },
  changes_requested: { text: "Changes requested", tone: "warn" },
  commented: { text: "Commented", tone: "quiet" },
  dismissed: { text: "Dismissed", tone: "quiet" },
};

const NOUN: Record<List, string> = { reviewers: "reviewer", assignees: "assignee" };

function Person(props: {
  login: string;
  state?: ReviewerState;
  /** Set when the person can be taken off the list. */
  onRemove?: () => void;
  removeLabel: string;
  busy: boolean;
}) {
  const state = props.state && STATE[props.state];
  return (
    <li>
      <span className="mono people-login">{props.login}</span>
      {state && <Status tone={state.tone}>{state.text}</Status>}
      {props.onRemove && (
        <button
          type="button"
          className="icon-btn"
          aria-label={props.removeLabel}
          title={props.removeLabel}
          disabled={props.busy}
          onClick={props.onRemove}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function PeopleCard(props: {
  pull: Ref;
  /** Whether the pull request still takes changes. */
  editable: boolean;
  /** Bumped when reviewers changed elsewhere on the page. */
  rev?: number;
  onChanged?: () => void;
}) {
  const { platform, repo, number } = props.pull;
  const repoQuery = new URLSearchParams({ platform, repo }).toString();
  const { data, reload } = useLoad(
    () => api<PullPeopleView>(`/pulls/people?${repoQuery}&number=${number}`),
    [repoQuery, number, props.rev],
  );
  const [adding, setAdding] = useState<List | null>(null);
  const [said, setSaid] = useState<PullActionOutcome | null>(null);
  const write = useAction((list: List, change: Pick<PullPeopleRequest, "add" | "remove">) =>
    api<{ outcome: PullActionOutcome }>(`/pulls/people/${list}`, {
      method: "POST",
      body: JSON.stringify({ ...props.pull, ...change } satisfies PullPeopleRequest),
    }),
  );
  if (!data?.reviewers) return null;
  const change = async (list: List, add: string[], remove: string[]) => {
    setAdding(null);
    const r = await write.run(list, { add, remove });
    if (!r) return;
    setSaid(r.outcome === "done" ? null : r.outcome);
    reload();
    if (list === "reviewers") props.onChanged?.();
  };
  const head = (list: List, title: string, none: string | false) => (
    <div className="row-gap checks-head">
      <h2 className="card-title grow">{title}</h2>
      {none && <span className="subtle small">{none}</span>}
      {props.editable && adding !== list && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add ${NOUN[list]}`}
          onClick={() => setAdding(list)}
        >
          Add
        </Button>
      )}
    </div>
  );
  const picker = (list: List, taken: readonly string[]) =>
    adding === list && (
      <PeoplePicker
        repoQuery={repoQuery}
        label={`Add ${NOUN[list]}`}
        taken={taken}
        onPick={(login) => change(list, [login], [])}
        onClose={() => setAdding(null)}
      />
    );
  const reviewers = data.reviewers.map((r) => r.login);
  return (
    <section className="card card-pad stack" aria-label="Reviewers and assignees">
      {head(
        "reviewers",
        "Reviewers",
        data.reviewers.length + data.teams.length === 0 && "No one asked",
      )}
      {picker("reviewers", data.author ? [...reviewers, data.author] : reviewers)}
      {data.reviewers.length + data.teams.length > 0 && (
        <ul className="people-list">
          {data.reviewers.map((r) => (
            <Person
              key={r.login}
              login={r.login}
              state={r.state}
              removeLabel={`Stop asking ${r.login}`}
              busy={write.busy}
              {...(props.editable && r.state === "requested"
                ? { onRemove: () => change("reviewers", [], [r.login]) }
                : {})}
            />
          ))}
          {data.teams.map((t) => (
            <li key={t.slug}>
              <span className="people-login">{t.name}</span>
              <span className="badge">Team asked</span>
            </li>
          ))}
        </ul>
      )}
      {data.truncated && (
        <span className="subtle small">
          More reviews than one listing reads; the rest are on the platform.
        </span>
      )}
      <div className="people-part stack">
        {head("assignees", "Assignees", data.assignees.length === 0 && "No one assigned")}
        {picker("assignees", data.assignees)}
        {data.assignees.length > 0 && (
          <ul className="people-list">
            {data.assignees.map((login) => (
              <Person
                key={login}
                login={login}
                removeLabel={`Unassign ${login}`}
                busy={write.busy}
                {...(props.editable ? { onRemove: () => change("assignees", [], [login]) } : {})}
              />
            ))}
          </ul>
        )}
      </div>
      {said && (
        <p className="error small m-0" role="alert">
          {OUTCOME[said]}
        </p>
      )}
      {write.error !== null && (
        <p className="error" role="alert">
          Could not change it: {why(write.error)}.
        </p>
      )}
    </section>
  );
}
