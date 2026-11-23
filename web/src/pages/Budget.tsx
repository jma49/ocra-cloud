import { api } from "../api.js";
import type { Budget } from "../budget/budget.js";
import { CallsCard } from "../budget/calls-card.js";
import { SpendCard } from "../budget/spend-card.js";
import { useCached } from "../cache.js";
import { LoadError, Loading, PageHead } from "../ui.js";

// The account's limits, each with a default it may change or turn off:
// what its reviews may cost a day and a month, and the model calls the
// gateway forwards for it a day. One review's spend is capped by Review
// settings, maxCostUsd.

export function BudgetPage() {
  const { data, error, reload } = useCached("/budget", () => api<Budget>("/budget"));
  if (error && !data) return <LoadError what="the budget" error={error} retry={reload} />;
  if (!data) return <Loading what="the budget" />;
  return (
    <>
      <PageHead
        title="Budget"
        sub="Limit what your reviews cost and how many model calls ocra Cloud's gateway forwards for you. Each limit starts at a default you can change or turn off. Days and months are UTC."
      />
      <SpendCard spend={data.spend} onSaved={reload} />
      <CallsCard budget={data} onSaved={reload} />
    </>
  );
}
