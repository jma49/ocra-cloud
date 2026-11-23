import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_SPEND_LIMIT_USD,
  type SpendView,
  type SpendWindowState,
  spendStates,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { usd } from "../format.js";
import { useAction } from "../ui.js";
import { type Budget, resetLabel } from "./budget.js";
import { draftOf, type LimitDraft, LimitField, savedOf } from "./limit-field.js";

// What the account's reviews may cost a UTC day and a calendar month. At a
// limit the server starts no hosted review until it resets or is raised.

const TITLE = { daily: "Today", monthly: "This month" } as const;

function Window(props: { state: SpendWindowState }) {
  const { window, spentUsd, limitUsd, used, level } = props.state;
  return (
    <div>
      <div className="budget-use">
        <span>
          <span className="subtle">{TITLE[window]}</span> <b>{usd(spentUsd)}</b>
          {limitUsd === null ? ", no limit" : ` of ${usd(limitUsd)}`}
        </span>
        <span className="subtle small">
          Resets {window === "daily" ? "at" : "on"} {resetLabel(window)}
        </span>
      </div>
      {limitUsd !== null && (
        <div className="meter" aria-hidden="true">
          <span
            style={{ width: `${used * 100}%` }}
            data-tone={level === "ok" ? undefined : "warn"}
          />
        </div>
      )}
      {level !== "ok" && (
        <p className="subtle small budget-note">
          {level === "reached"
            ? "The limit is reached: hosted reviews wait until it resets or you raise it."
            : "Over 80% used."}
        </p>
      )}
    </div>
  );
}

/** A dollar limit as typed, or undefined when it is not one. */
function readUsd(text: string): number | undefined {
  const n = Math.round(Number(text) * 100) / 100;
  return n >= 0.01 && n <= MAX_SPEND_LIMIT_USD ? n : undefined;
}

export function SpendCard(props: { spend: SpendView; onSaved: () => void }) {
  const { spend } = props;
  const [draft, setDraft] = useState<{ daily?: LimitDraft; monthly?: LimitDraft }>({});
  const save = useAction((limits: Pick<SpendView, "dailyUsd" | "monthlyUsd">) =>
    api<Budget>("/budget/spend", { method: "PUT", body: JSON.stringify(limits) }),
  );
  const daily = draft.daily ?? draftOf(spend.dailyUsd);
  const monthly = draft.monthly ?? draftOf(spend.monthlyUsd);
  const dailyUsd = savedOf(daily, readUsd);
  const monthlyUsd = savedOf(monthly, readUsd);
  const valid = dailyUsd !== undefined && monthlyUsd !== undefined;
  const submit = async () => {
    if (dailyUsd === undefined || monthlyUsd === undefined) return;
    if ((await save.run({ dailyUsd, monthlyUsd })) !== undefined) {
      setDraft({});
      props.onSaved();
    }
  };
  return (
    <div className="card spend-card">
      <div className="card-head">
        <h3>Spend limit</h3>
        <span className="subtle small">US dollars, from the cost each review reports</span>
      </div>
      <div className="card-pad stack">
        {spendStates(spend).map((state) => (
          <Window key={state.window} state={state} />
        ))}
        <form
          className="row-gap wrap center"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <LimitField
            label="Daily limit"
            fallback={usd(spend.defaults.dailyUsd)}
            draft={daily}
            onChange={(d) => setDraft({ ...draft, daily: d })}
          />
          <LimitField
            label="Monthly limit"
            fallback={usd(spend.defaults.monthlyUsd)}
            draft={monthly}
            onChange={(d) => setDraft({ ...draft, monthly: d })}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!valid || save.busy}>
            Save
          </Button>
        </form>
        {!valid && (
          <p className="error small">
            A limit is an amount from $0.01 to {usd(MAX_SPEND_LIMIT_USD)}.
          </p>
        )}
        {save.error ? (
          <p className="error" role="alert">
            Could not save it: {why(save.error)}.
          </p>
        ) : null}
        <p className="subtle small m-0">
          Leave a limit empty for its default, or turn it off. You are warned at 80% of a limit, and
          each hosted review may spend at most what is left before the nearer one.
        </p>
      </div>
    </div>
  );
}
