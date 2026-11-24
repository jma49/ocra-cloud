import Download from "lucide-react/icons/download";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Ledger, LedgerRow } from "../api.js";
import { useRead } from "../cache.js";
import { compact, count, num, usd } from "../format.js";
import { StackTable } from "../stack-table.js";
import { EmptyNote, LoadError, Loading, Seg } from "../ui.js";

// What the account's model calls used and cost in a calendar month, by UTC
// day and model, and the month as a CSV to set beside the provider's own
// usage export.

/** "2026-11" as "Nov 2026". */
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Dollars to the cent, a cost under a cent shown as such rather than as nothing. */
const cost = (n: number) => (n > 0 && n < 0.005 ? "<$0.01" : usd(n));

export function SpendLedger() {
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked ? `/ledger?month=${picked}` : "/ledger";
  const { data, error, reload } = useRead<Ledger>(path);
  return (
    <div className="section card">
      <div className="card-head">
        <h2>Spend by day</h2>
        <span className="subtle">Each UTC day's model calls, at list prices</span>
        {data && (
          <div className="row-gap">
            {data.months.length > 1 && (
              <Seg
                label="Month"
                value={data.month}
                options={data.months.map((m) => ({ value: m, label: monthLabel(m) }))}
                onChange={setPicked}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              render={<a href={`/api/ledger/csv?month=${data.month}`} download />}
            >
              <Download aria-hidden="true" />
              CSV
            </Button>
          </div>
        )}
      </div>
      {error && !data ? (
        <LoadError what="spend" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="spend by day" inCard />
      ) : data.rows.length === 0 ? (
        <EmptyNote>No model calls in {monthLabel(data.month)}</EmptyNote>
      ) : (
        <LedgerTable rows={data.rows} />
      )}
    </div>
  );
}

const COLUMNS = ["Requests", "Input", "Cache write", "Cache read", "Output", "Cost"] as const;

function totalOf(rows: readonly LedgerRow[]): LedgerRow {
  const sum = (k: keyof LedgerRow) => rows.reduce((n, r) => n + (r[k] as number), 0);
  return {
    day: "",
    provider: "",
    model: "",
    calls: sum("calls"),
    failed: sum("failed"),
    input: sum("input"),
    cacheWrite5m: sum("cacheWrite5m"),
    cacheWrite1h: sum("cacheWrite1h"),
    cacheRead: sum("cacheRead"),
    output: sum("output"),
    costUsd: sum("costUsd"),
    unpriced: sum("unpriced"),
  };
}

function costCell(r: LedgerRow): string {
  if (r.unpriced === 0) return cost(r.costUsd);
  const unpriced = `${count(r.unpriced, "call")} unpriced`;
  return r.unpriced === r.calls ? "Unpriced" : `${cost(r.costUsd)} + ${unpriced}`;
}

function Cells(props: { row: LedgerRow }) {
  const r = props.row;
  const values = [
    num(r.calls),
    compact(r.input),
    compact(r.cacheWrite5m + r.cacheWrite1h),
    compact(r.cacheRead),
    compact(r.output),
    costCell(r),
  ];
  return values.map((v, i) => (
    <td key={COLUMNS[i]} className="num">
      <span className="cell-name" aria-hidden="true">
        {COLUMNS[i]}
      </span>
      {v}
    </td>
  ));
}

function LedgerTable(props: { rows: readonly LedgerRow[] }) {
  return (
    <StackTable>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Model</th>
            {COLUMNS.map((c) => (
              <th key={c} className="num">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={`${r.day}/${r.provider}/${r.model}`}>
              <td className="muted">{r.day}</td>
              <td>
                {r.model} <span className="subtle">{r.provider}</span>
              </td>
              <Cells row={r} />
            </tr>
          ))}
          <tr>
            <td className="muted">Total</td>
            <td />
            <Cells row={totalOf(props.rows)} />
          </tr>
        </tbody>
      </table>
    </StackTable>
  );
}
