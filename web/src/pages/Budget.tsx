import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, why } from "../api.js";
import { type Budget, dailyLimit, resetsAt } from "../budget/budget.js";
import { SpendCard } from "../budget/spend-card.js";
import { useCached } from "../cache.js";
import { num } from "../format.js";
import { LoadError, Loading, PageHead, useAction } from "../ui.js";

// The account's limits: what its reviews may cost a day and a month, and
// its own daily limit on gateway calls, under the service's cap. One
// review's spend is capped by Review settings, maxCostUsd.

export function BudgetPage() {
  const { data, error, reload } = useCached("/budget", () => api<Budget>("/budget"));
  const [draft, setDraft] = useState<string>();
  const save = useAction((dailyCalls: number | null) =>
    api<Budget>("/budget", { method: "PUT", body: JSON.stringify({ dailyCalls }) }),
  );
  if (error && !data) return <LoadError what="the budget" error={error} retry={reload} />;
  if (!data) return <Loading what="the budget" />;
  const value = draft ?? (data.dailyCalls === null ? "" : String(data.dailyCalls));
  const limit = dailyLimit(data);
  const used = limit > 0 ? Math.min(data.callsToday / limit, 1) : 0;
  const reset = resetsAt().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const parsed = value.trim() === "" ? null : Math.trunc(Number(value));
  const valid = parsed === null || (parsed >= 1 && Number.isFinite(parsed));
  const submit = async () => {
    if ((await save.run(parsed)) !== undefined) {
      setDraft(undefined);
      reload();
    }
  };
  return (
    <>
      <PageHead
        title="Budget"
        sub="Limit what your reviews cost and how many model calls ocra Cloud's gateway forwards for you. Days and months are UTC. One review's limit is under Review settings."
      />
      <SpendCard spend={data.spend} onSaved={reload} />
      <div className="card">
        <div className="card-head">
          <h3>Daily calls</h3>
        </div>
        <div className="card-pad stack">
          <div>
            <div className="budget-use">
              <span>
                <b>{num(data.callsToday)}</b> of {num(limit)} calls today
              </span>
              <span className="subtle small">Resets at {reset}</span>
            </div>
            <div className="meter" aria-hidden="true">
              <span
                style={{ width: `${used * 100}%` }}
                data-tone={used >= 0.8 ? "warn" : undefined}
              />
            </div>
            <p className="subtle small budget-note">
              {used >= 1
                ? "The limit is reached: reviews wait until it resets."
                : used >= 0.8
                  ? "Over 80% used."
                  : null}{" "}
              The service allows {num(data.serviceDailyCalls)} calls a day for an account.
            </p>
          </div>
          <form
            className="row-gap wrap center"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void submit();
            }}
          >
            <label className="row-gap center">
              <span className="nobreak">Your daily limit</span>
              <input
                type="number"
                className="input"
                min={1}
                placeholder="No limit of your own"
                value={value}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <Button type="submit" variant="outline" size="sm" disabled={!valid || save.busy}>
              Save
            </Button>
          </form>
          {!valid && <p className="error small">A limit is a whole number of at least 1.</p>}
          {save.error ? (
            <p className="error" role="alert">
              Could not save it: {why(save.error)}.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
