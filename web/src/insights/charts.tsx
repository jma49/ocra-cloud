import type { ReactNode } from "react";
import { BarList } from "../charts/bar-list.js";
import { DayChart } from "../charts/day-chart.js";
import { num, usd } from "../format.js";
import { EmptyNote } from "../ui.js";
import { type Acceptance, acceptanceChart, type Daily, flat, type Point } from "./series.js";

// The insights charts: findings, spend and review time per day, acceptance
// per reviewer, and why findings were dismissed.

const dayOf = (p: Point) => p.start.toISOString().slice(0, 10);
/** A series on the given days, null where it has no point (review time on a day without reviews). */
const on = (days: string[], points: Point[]) => {
  const by = new Map(points.map((p) => [dayOf(p), p.value]));
  return days.map((d) => by.get(d) ?? null);
};
const seconds = (n: number) => (n >= 600 ? `${Math.round(n / 60)}m` : `${Math.round(n)}s`);
const dollars = (n: number) => (n >= 100 ? `$${Math.round(n)}` : usd(n));

function Chart(props: { title: string; sub: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`card chart-card${props.wide ? " wide" : ""}`} aria-label={props.title}>
      <div className="chart-head">
        <h2>{props.title}</h2>
        <span className="subtle">{props.sub}</span>
      </div>
      {props.children}
    </section>
  );
}

export type ChartsProps = {
  daily: Daily;
  acceptance: Acceptance[];
  reasons: { reason: string; n: number }[];
};

export function Charts(props: ChartsProps) {
  const { daily } = props;
  const days = daily.critical.map(dayOf);
  const dismissed = props.reasons.reduce((n, r) => n + r.n, 0);
  const accepted = acceptanceChart(props.acceptance);
  return (
    <div className="charts">
      <Chart title="Findings by severity" sub="per day" wide>
        {flat(daily.critical) && flat(daily.warning) && flat(daily.suggestion) ? (
          <EmptyNote>No findings in this period</EmptyNote>
        ) : (
          <DayChart
            label="Findings by severity per day"
            kind="bars"
            days={days}
            format={num}
            series={[
              { name: "Critical", color: "var(--red)", values: on(days, daily.critical) },
              { name: "Warning", color: "var(--amber)", values: on(days, daily.warning) },
              { name: "Suggestion", color: "var(--c5)", values: on(days, daily.suggestion) },
            ]}
          />
        )}
      </Chart>
      <Chart title="Acceptance by reviewer" sub="of decided findings">
        {"decided" in accepted ? (
          <EmptyNote>
            {accepted.decided === 0
              ? "No decided findings yet"
              : `${accepted.decided} decided so far: too few to compare reviewers`}
          </EmptyNote>
        ) : (
          <BarList
            label="Acceptance by reviewer"
            max={100}
            rows={[...accepted.bars]
              .sort((a, b) => b.rate - a.rate)
              .map((a) => ({
                key: a.reviewer,
                label: a.reviewer,
                value: a.rate * 100,
                text: `${Math.round(a.rate * 100)}%`,
              }))}
          />
        )}
      </Chart>
      <Chart title="Spend" sub="per day" wide>
        {flat(daily.spend) ? (
          <EmptyNote>Nothing spent in this period</EmptyNote>
        ) : (
          <DayChart
            label="Spend per day"
            kind="bars"
            days={days}
            format={dollars}
            series={[{ name: "Spend", color: "var(--c2)", values: on(days, daily.spend) }]}
          />
        )}
      </Chart>
      <Chart title="Review time" sub="p50 and p95">
        {daily.p50.length === 0 ? (
          <EmptyNote>No reviews in this period</EmptyNote>
        ) : (
          <DayChart
            label="Review time per day, p50 and p95"
            kind="lines"
            days={days}
            format={seconds}
            series={[
              { name: "p50", color: "var(--c1)", values: on(days, daily.p50) },
              { name: "p95", color: "var(--c2)", values: on(days, daily.p95) },
            ]}
          />
        )}
      </Chart>
      {dismissed > 0 && (
        <Chart title="Why findings were dismissed" sub={`${num(dismissed)} dismissed`} wide>
          <BarList
            label="Why findings were dismissed"
            max={dismissed}
            rows={[...props.reasons]
              .sort((a, b) => b.n - a.n)
              .map((r) => ({
                key: r.reason,
                label: r.reason,
                value: r.n,
                text: `${Math.round((r.n / dismissed) * 100)}% · ${num(r.n)}`,
              }))}
          />
        </Chart>
      )}
    </div>
  );
}
