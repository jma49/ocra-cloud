import "./dt-runtime.js";
import {
  CategoricalBarChart,
  DonutChart,
  TimeseriesChart,
} from "@dynatrace/strato-components/charts";
import { AppRoot } from "@dynatrace/strato-components/core";
import type { ReactNode } from "react";
import { EmptyNote } from "../ui.js";
import { type Daily, flat, type Point } from "./series.js";

// The insights charts, drawn with Dynatrace's Strato charts (Apache-2.0).
// This module and the library load only when Insights opens. Series take
// their colours from the console's tokens, so they follow light and dark.

const tone = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const line = (name: string, datapoints: Point[]) => ({ name, datapoints });

function Chart(props: { title: string; sub: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`card chart-card${props.wide ? " wide" : ""}`} aria-label={props.title}>
      <div className="chart-head">
        <h2>{props.title}</h2>
        <span className="subtle">{props.sub}</span>
      </div>
      <div className="chart-body">{props.children}</div>
    </section>
  );
}

export type ChartsProps = {
  daily: Daily;
  acceptance: { reviewer: string; rate: number }[];
  reasons: { reason: string; n: number }[];
};

export default function Charts(props: ChartsProps) {
  const { daily } = props;
  const muted = tone("c5");
  return (
    <AppRoot>
      <div className="charts">
        <Chart title="Findings by severity" sub="per day" wide>
          {flat(daily.critical) && flat(daily.warning) && flat(daily.suggestion) ? (
            <EmptyNote>No findings in this period</EmptyNote>
          ) : (
            <TimeseriesChart
              variant="bar"
              height={220}
              colorPalette={{ Critical: tone("red"), Warning: tone("amber"), Suggestion: muted }}
              data={[
                line("Critical", daily.critical),
                line("Warning", daily.warning),
                line("Suggestion", daily.suggestion),
              ]}
            >
              <TimeseriesChart.Legend position="bottom" />
            </TimeseriesChart>
          )}
        </Chart>
        <Chart title="Acceptance by reviewer" sub="% of decided findings">
          {props.acceptance.length === 0 ? (
            <EmptyNote>No decided findings yet</EmptyNote>
          ) : (
            <CategoricalBarChart
              height={220}
              layout="horizontal"
              data={props.acceptance.map((a) => ({
                category: a.reviewer,
                value: Math.round(a.rate * 100),
                color: tone("ink"),
              }))}
            >
              <CategoricalBarChart.Legend hidden />
            </CategoricalBarChart>
          )}
        </Chart>
        <Chart title="Spend" sub="USD per day" wide>
          {flat(daily.spend) ? (
            <EmptyNote>Nothing spent in this period</EmptyNote>
          ) : (
            <TimeseriesChart
              variant="area"
              height={220}
              pointsDisplay="never"
              colorPalette={{ Spend: tone("blue") }}
              data={[line("Spend", daily.spend)]}
            >
              <TimeseriesChart.Legend hidden />
            </TimeseriesChart>
          )}
        </Chart>
        <Chart title="Review time" sub="seconds, p50 and p95">
          {daily.p50.length === 0 ? (
            <EmptyNote>No reviews in this period</EmptyNote>
          ) : (
            <TimeseriesChart
              variant="line"
              curve="smooth"
              height={220}
              colorPalette={{ p50: tone("ink"), p95: tone("blue") }}
              data={[line("p50", daily.p50), line("p95", daily.p95)]}
            >
              <TimeseriesChart.Legend position="bottom" />
            </TimeseriesChart>
          )}
        </Chart>
        {props.reasons.length > 0 && (
          <Chart title="Why findings were dismissed" sub="share of dismissed" wide>
            <DonutChart
              height={220}
              colorPalette={[tone("ink"), tone("blue"), tone("teal"), muted]}
              data={{ slices: props.reasons.map((r) => ({ category: r.reason, value: r.n })) }}
            >
              <DonutChart.Legend position="right" />
            </DonutChart>
          </Chart>
        )}
      </div>
    </AppRoot>
  );
}
