import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LIMIT_OFF } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { num } from "../format.js";
import { useAction } from "../ui.js";
import { type Budget, dailyLimit, resetLabel } from "./budget.js";
import { draftOf, type LimitDraft, LimitField, savedOf } from "./limit-field.js";

// The model calls ocra Cloud's gateway forwards for the account a UTC day:
// the server's default, a number of its own up to the server's ceiling, or
// off, which leaves only the ceiling.

export function CallsCard(props: { budget: Budget; onSaved: () => void }) {
  const { budget } = props;
  const [draft, setDraft] = useState<LimitDraft>();
  const save = useAction((dailyCalls: number | null) =>
    api<Budget>("/budget", { method: "PUT", body: JSON.stringify({ dailyCalls }) }),
  );
  const limit = dailyLimit(budget);
  const off = budget.dailyCalls === LIMIT_OFF;
  const used = limit > 0 ? Math.min(budget.callsToday / limit, 1) : 1;
  const shown = draft ?? draftOf(budget.dailyCalls);
  const read = (text: string) => {
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 && n <= budget.maxDailyCalls ? n : undefined;
  };
  const dailyCalls = savedOf(shown, read);
  const submit = async () => {
    if (dailyCalls === undefined) return;
    if ((await save.run(dailyCalls)) !== undefined) {
      setDraft(undefined);
      props.onSaved();
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Daily calls</h3>
        <span className="subtle small">Model calls the gateway forwards for you</span>
      </div>
      <div className="card-pad stack">
        <div>
          <div className="budget-use">
            <span>
              <b>{num(budget.callsToday)}</b> of {num(limit)} calls today
            </span>
            <span className="subtle small">Resets at {resetLabel("daily")}</span>
          </div>
          <div className="meter" aria-hidden="true">
            <span
              style={{ width: `${used * 100}%` }}
              data-tone={used >= 0.8 ? "warn" : undefined}
            />
          </div>
          {(used >= 0.8 || off) && (
            <p className="subtle small budget-note">
              {used >= 1
                ? "The limit is reached: reviews wait until it resets or you raise it."
                : used >= 0.8
                  ? "Over 80% used."
                  : `Your limit is off; this server stops at ${num(budget.maxDailyCalls)}.`}
            </p>
          )}
        </div>
        <form
          className="row-gap wrap center"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <LimitField
            label="Daily limit"
            fallback={num(budget.serviceDailyCalls)}
            draft={shown}
            onChange={setDraft}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={dailyCalls === undefined || save.busy}
          >
            Save
          </Button>
        </form>
        {dailyCalls === undefined && (
          <p className="error small">
            A limit is a whole number from 1 to {num(budget.maxDailyCalls)}.
          </p>
        )}
        {save.error ? (
          <p className="error" role="alert">
            Could not save it: {why(save.error)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
