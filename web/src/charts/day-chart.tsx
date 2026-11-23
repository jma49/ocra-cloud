import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { dayLabel, niceMax, slotAt, stepKey, tipSide } from "./scale.js";

// A value per day for one or more series, drawn as stacked bars or as lines
// with a mark on each day that has a value. Pointer or arrow keys pick a day (the plot is a slider over
// the days, so a screen reader hears each day's values); its tooltip lists
// every series, values first. A table beside it holds every value.

type DaySeries = {
  name: string;
  /** A token, such as "var(--c1)". */
  color: string;
  /** One per day; null where the day has no value (a line passes over it). */
  values: (number | null)[];
};

type Props = {
  /** What the chart shows, as its accessible name. */
  label: string;
  /** UTC days, "2026-11-23". */
  days: string[];
  series: DaySeries[];
  kind: "bars" | "lines";
  format: (n: number) => string;
  /** Name the only series under the chart too, when the title does not (a model's name). */
  legend?: boolean;
};

const W = 1000;
const H = 180;

export function DayChart(props: Props) {
  const { days, series, kind, format } = props;
  const [at, setAt] = useState<number | null>(null);
  const n = days.length;
  const slot = W / Math.max(1, n);
  const stackTotal = (i: number) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0);
  const peak =
    kind === "bars"
      ? Math.max(0, ...days.map((_, i) => stackTotal(i)))
      : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const top = niceMax(peak);
  const y = (v: number) => H - (v / top) * H;
  const cx = (i: number) => i * slot + slot / 2;
  const pct = at === null ? 0 : (cx(at) / W) * 100;

  const readout = (i: number) =>
    `${dayLabel(days[i] ?? "")}: ${series
      .map((s) => `${s.values[i] == null ? "none" : format(s.values[i] ?? 0)} ${s.name}`)
      .join(", ")}`;

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(slotAt(e.clientX - box.left, box.width, n));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepKey(e.key, at, n);
    if (next === null) return;
    e.preventDefault();
    setAt(next);
  };

  return (
    <figure className="dchart">
      <div className="dchart-frame">
        <div className="dchart-ticks" aria-hidden="true">
          <span style={{ bottom: "100%" }}>{format(top)}</span>
          <span style={{ bottom: "50%" }}>{format(top / 2)}</span>
          <span style={{ bottom: "0%" }}>{format(0)}</span>
        </div>
        <div
          className="dchart-plot"
          role="slider"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, n - 1)}
          aria-valuenow={at ?? n - 1}
          aria-valuetext={readout(at ?? n - 1)}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setAt(null)}
          onKeyDown={key}
          onFocus={() => setAt((a) => a ?? n - 1)}
          onBlur={() => setAt(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                className={f === 1 ? "dchart-base" : "dchart-grid"}
                x1="0"
                x2={W}
                y1={H * f}
                y2={H * f}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {kind === "bars" ? (
              <Bars series={series} days={days} slot={slot} at={at} y={y} />
            ) : (
              series.map((s) => <Line key={s.name} s={s} cx={cx} y={y} />)
            )}
            {at !== null && kind !== "bars" && (
              <line
                className="dchart-cross"
                x1={cx(at)}
                x2={cx(at)}
                y1="0"
                y2={H}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {at !== null &&
            kind !== "bars" &&
            series.map((s) => {
              const v = s.values[at];
              return v == null ? null : (
                <i
                  key={s.name}
                  className="dchart-dot"
                  style={{ left: `${pct}%`, top: `${(y(v) / H) * 100}%`, background: s.color }}
                />
              );
            })}
          {at !== null && (
            <div className="dchart-tip" data-side={tipSide(pct)} style={{ left: `${pct}%` }}>
              <div className="dchart-tip-day">{dayLabel(days[at] ?? "")}</div>
              {series.length > 1 && kind === "bars" && (
                <div className="dchart-tip-row">
                  <b>{format(stackTotal(at))}</b>
                  <span>Total</span>
                </div>
              )}
              {series.map((s) => {
                const v = s.values[at];
                return (
                  <div key={s.name} className="dchart-tip-row">
                    <i style={{ background: s.color }} />
                    <b>{v == null ? "–" : format(v)}</b>
                    <span>{s.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <span />
        <div className="dchart-axis" aria-hidden="true">
          <span>{dayLabel(days[0] ?? "")}</span>
          {n > 2 && <span>{dayLabel(days[Math.floor((n - 1) / 2)] ?? "")}</span>}
          <span>{dayLabel(days.at(-1) ?? "")}</span>
        </div>
      </div>
      {(series.length > 1 || props.legend) && (
        <div className="legend" aria-hidden="true">
          {series.map((s) => (
            <span key={s.name}>
              <i
                className={kind === "bars" ? undefined : "legend-line"}
                style={{ background: s.color }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <table className="sr-only">
        <caption>{props.label}</caption>
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.name}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <td>{dayLabel(d)}</td>
              {series.map((s) => {
                const v = s.values[i];
                return <td key={s.name}>{v == null ? "–" : format(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// A 2 px seam of the card between stacked segments; a day with nothing keeps a hairline at the base.
const SEAM = 2;

function Bars(props: {
  series: DaySeries[];
  days: string[];
  slot: number;
  at: number | null;
  y: (v: number) => number;
}) {
  const { series, slot, at, y } = props;
  const gap = Math.min(slot * 0.3, 8);
  const bw = slot - gap;
  return props.days.map((day, i) => {
    const x = i * slot + gap / 2;
    let sum = 0;
    const dim = at !== null && at !== i;
    const segs = series.flatMap((s) => {
      const v = s.values[i] ?? 0;
      if (v <= 0) return [];
      const top = y(sum + v);
      const h = y(sum) - top - (sum > 0 ? SEAM : 0);
      sum += v;
      return [{ name: s.name, color: s.color, y: top, h: Math.max(1, h) }];
    });
    return (
      <g key={day} className={dim ? "dchart-dim" : undefined}>
        {segs.map((s) => (
          <rect key={s.name} x={x} y={s.y} width={bw} height={s.h} fill={s.color} rx="1.5" />
        ))}
      </g>
    );
  });
}

/** A line through the days that have a value, over the ones that do not, with a mark on each of them. */
function Line(props: { s: DaySeries; cx: (i: number) => number; y: (v: number) => number }) {
  const { s, cx, y } = props;
  const pts = s.values.flatMap((v, i) => (v == null ? [] : [[cx(i), y(v)] as const]));
  if (pts.length === 0) return null;
  const d = pts.map(([x, py], i) => `${i ? "L" : "M"}${x},${py}`).join("");
  const marks = pts.map(([x, py]) => `M${x},${py}h0`).join("");
  return (
    <g stroke={s.color}>
      {pts.length > 1 && <path d={d} className="dchart-line" vectorEffect="non-scaling-stroke" />}
      <path d={marks} className="dchart-marks" vectorEffect="non-scaling-stroke" />
    </g>
  );
}
