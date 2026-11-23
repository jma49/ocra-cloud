import { useEffect, useState } from "react";
import {
  MAX_PEOPLE_PREFIX,
  type PullCandidate,
  type PullCandidatesView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";

// The search shares the platforms' request allowance, so a keystroke waits before it asks.
const WAIT_MS = 250;

type Found = { prefix: string; view: PullCandidatesView | null };

/** The repository's people whose login starts with what is typed; picking one closes it. */
export function PeoplePicker(props: {
  repoQuery: string;
  label: string;
  /** Logins already in the list being added to. */
  taken: readonly string[];
  onPick: (login: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const prefix = typed.trim().slice(0, MAX_PEOPLE_PREFIX);
  const [found, setFound] = useState<Found | null>(null);
  const { repoQuery } = props;
  useEffect(() => {
    if (!prefix) return;
    let live = true;
    const timer = setTimeout(() => {
      api<PullCandidatesView>(
        `/pulls/people/candidates?${repoQuery}&${new URLSearchParams({ prefix })}`,
      ).then(
        (view) => live && setFound({ prefix, view }),
        () => live && setFound({ prefix, view: null }),
      );
    }, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repoQuery, prefix]);
  const answer = prefix && found?.prefix === prefix ? found : null;
  const open = (answer?.view?.candidates ?? []).filter((c) => !props.taken.includes(c.login));
  return (
    <div className="people-picker">
      <input
        className="input"
        type="search"
        // biome-ignore lint/a11y/noAutofocus: the field opens on the press of "Add", for typing
        autoFocus
        aria-label={props.label}
        placeholder="Type a username"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      />
      {answer && (
        <ul className="people-found" aria-label="People found">
          {open.map((c: PullCandidate) => (
            <li key={c.login}>
              <button type="button" className="people-option" onClick={() => props.onPick(c.login)}>
                <span className="mono">{c.login}</span>
                {c.name && <span className="subtle small">{c.name}</span>}
              </button>
            </li>
          ))}
          {open.length === 0 && (
            <li className="subtle small">
              {answer.view ? "No one else matches." : "The platform did not answer."}
            </li>
          )}
          {answer.view?.truncated && <li className="subtle small">Type more to narrow it.</li>}
        </ul>
      )}
    </div>
  );
}
