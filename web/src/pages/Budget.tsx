import { useState } from "react";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { num } from "../format.js";
import { LoadError, Loading, PageHead, useAction } from "../ui.js";

// The account's own daily limit on gateway calls, under the service's cap.
// A review's spend in dollars is capped by Review settings, maxCostUsd.

type Budget = { serviceDailyCalls: number; dailyCalls: number | null; callsToday: number };

export function BudgetPage() {
  const { data, error, reload } = useCached("/budget", () => api<Budget>("/budget"));
  const [draft, setDraft] = useState<string>();
  const save = useAction((dailyCalls: number | null) =>
    api<Budget>("/budget", { method: "PUT", body: JSON.stringify({ dailyCalls }) }),
  );
  if (error && !data) return <LoadError what="the budget" error={error} retry={reload} />;
  if (!data) return <Loading what="the budget" />;
  const value = draft ?? (data.dailyCalls === null ? "" : String(data.dailyCalls));
  const limit = data.dailyCalls ?? data.serviceDailyCalls;
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
        sub="Limit how many model calls ocra Cloud's gateway forwards for you a day (UTC). A review's dollar limit is under Review settings."
      />
      <div className="card">
        <p>
          Today: {num(data.callsToday)} of {num(limit)} calls
          {data.callsToday >= limit * 0.8 ? " (80% or more used)" : ""}. The service allows{" "}
          {num(data.serviceDailyCalls)} a day.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          <label>
            Your daily limit{" "}
            <input
              type="number"
              min={1}
              placeholder="No limit of your own"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-sm" disabled={!valid || save.busy}>
            Save
          </button>
        </form>
        {!valid && <p className="error small">A limit is a whole number of at least 1.</p>}
        {save.error ? (
          <p className="error" role="alert">
            Could not save it: {why(save.error)}.
          </p>
        ) : null}
      </div>
    </>
  );
}
