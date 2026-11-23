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

// What the account's reviews may cost a UTC day and a calendar month. At a
// limit the server starts no hosted review until it resets or is raised.

const TITLE = { daily: "Today", monthly: "This month" } as const;

function Window(props: { state: SpendWindowState }) {
  const { window, spentUsd, limitUsd, used, level } = props.state;
  const reset = resetLabel(window);
  return (
    <div>
      <div className="budget-use">
        <span>
          <span className="subtle">{TITLE[window]}</span> <b>{usd(spentUsd)}</b> of {usd(limitUsd)}
        </span>
        <span className="subtle small">
          Resets {window === "daily" ? "at" : "on"} {reset}
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${used * 100}%` }} data-tone={level === "ok" ? undefined : "warn"} />
      </div>
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

/** A limit as typed: empty for the default, undefined when it is not a limit. */
function parse(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Math.round(Number(text) * 100) / 100;
  return n >= 0.01 && n <= MAX_SPEND_LIMIT_USD ? n : undefined;
}

const shown = (limit: number | null) => (limit === null ? "" : String(limit));

export function SpendCard(props: { spend: SpendView; onSaved: () => void }) {
  const { spend } = props;
  const [draft, setDraft] = useState<{ daily?: string; monthly?: string }>({});
  const save = useAction((limits: Pick<SpendView, "dailyUsd" | "monthlyUsd">) =>
    api<Budget>("/budget/spend", { method: "PUT", body: JSON.stringify(limits) }),
  );
  const daily = parse(draft.daily ?? shown(spend.dailyUsd));
  const monthly = parse(draft.monthly ?? shown(spend.monthlyUsd));
  const valid = daily !== undefined && monthly !== undefined;
  const submit = async () => {
    if (!valid) return;
    if ((await save.run({ dailyUsd: daily, monthlyUsd: monthly })) !== undefined) {
      setDraft({});
      props.onSaved();
    }
  };
  const field = (window: "daily" | "monthly", label: string, own: number | null, base: number) => (
    <label className="row-gap center">
      <span className="nobreak">{label}</span>
      <input
        className="input"
        inputMode="decimal"
        placeholder={`${usd(base)} by default`}
        value={draft[window] ?? shown(own)}
        onChange={(e) => setDraft({ ...draft, [window]: e.target.value })}
      />
    </label>
  );
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
          {field("daily", "Daily limit", spend.dailyUsd, spend.defaults.dailyUsd)}
          {field("monthly", "Monthly limit", spend.monthlyUsd, spend.defaults.monthlyUsd)}
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
          You are warned at 80% of a limit. Each hosted review may spend at most what is left before
          the nearer limit.
        </p>
      </div>
    </div>
  );
}
