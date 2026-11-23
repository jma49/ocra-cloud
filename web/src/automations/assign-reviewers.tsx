import {
  type AssignReviewers,
  type AssignStrategy,
  MAX_ASSIGN_COUNT,
  MAX_ASSIGN_LOGINS,
} from "../../../src/shared/index.js";
import { GlobList } from "../form.js";
import { Seg } from "../ui.js";

// What an "Assign reviewers" action asks for: how they are chosen, how many,
// and for the two strategies that choose from a list, that list.

const STRATEGIES: { value: AssignStrategy; label: string }[] = [
  { value: "suggested", label: "Suggested" },
  { value: "round_robin", label: "In turn" },
  { value: "least_loaded", label: "Least loaded" },
];
const HOW: Record<AssignStrategy, string> = {
  suggested: "The best of those the console suggests for the change.",
  round_robin: "The people below, one after another.",
  least_loaded: "Those below with the fewest open review requests.",
};
const COUNTS = Array.from({ length: MAX_ASSIGN_COUNT }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
}));

export const newAssign = (): AssignReviewers => ({
  kind: "assign_reviewers",
  strategy: "suggested",
  count: 1,
});

const choosesFromList = (a: AssignReviewers) => a.strategy !== "suggested";

export const assignReady = (a: AssignReviewers) =>
  !choosesFromList(a) || (a.logins?.length ?? 0) > 0;

/** What is saved: the list is kept in the form across strategies, but only sent with one that uses it. */
export function assignAction(a: AssignReviewers): AssignReviewers {
  const { logins, ...rest } = a;
  return choosesFromList(a) ? { ...rest, logins: logins ?? [] } : rest;
}

export function AssignFields(props: {
  value: AssignReviewers;
  n: number;
  onChange: (v: AssignReviewers) => void;
}) {
  const { value: a, n } = props;
  const set = (change: Partial<AssignReviewers>) => props.onChange({ ...a, ...change });
  const logins = a.logins ?? [];
  return (
    <div className="assign-fields grow">
      <Seg
        label={`How reviewers are chosen, action ${n}`}
        value={a.strategy}
        options={STRATEGIES}
        onChange={(strategy) => set({ strategy })}
      />
      <span className="muted small">{HOW[a.strategy]}</span>
      <div className="assign-count">
        <span className="small">How many</span>
        <Seg
          label={`How many reviewers, action ${n}`}
          value={a.count}
          options={COUNTS}
          onChange={(count) => set({ count })}
        />
      </div>
      {choosesFromList(a) && (
        <>
          <GlobList
            label={`People to choose from, action ${n}`}
            placeholder="A login, then Enter"
            value={logins}
            onChange={(v) => set({ logins: v.slice(0, MAX_ASSIGN_LOGINS) })}
          />
          <span className="muted small">
            {logins.length === 0
              ? "Add at least one person."
              : logins.length >= MAX_ASSIGN_LOGINS
                ? `${MAX_ASSIGN_LOGINS} people at most.`
                : a.strategy === "round_robin"
                  ? "Asked in this order."
                  : "The author and those already asked are left out."}
          </span>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          aria-label={`Code owners first, action ${n}`}
          checked={a.codeOwnersFirst ?? false}
          onChange={(e) => set({ codeOwnersFirst: e.target.checked })}
        />
        Code owners of the changed files first
      </label>
    </div>
  );
}
