import { Component, type ReactNode, useEffect, useState } from "react";
import { api, compact, type Day, type ProviderInfo, why } from "./api.js";
import { Link } from "./router.js";

export function PageHead(props: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <p>{props.sub}</p>}
      </div>
      {props.actions}
    </div>
  );
}

/** One choice of a few, as toggle buttons (not tabs: no panels follow). */
export function Seg<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset className="seg" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Loads once per change of deps; returns [data, error, reload]. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    let live = true;
    load().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
      },
      (e) => {
        if (live) setError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [n, ...deps]);
  return [data, error, () => setN((x) => x + 1)] as const;
}

/** The providers the gateway forwards (public; the same list the CLI reads). */
export function useProviders(): ProviderInfo[] | undefined {
  const [data] = useLoad(() => api<{ providers: ProviderInfo[] }>("/providers"));
  return data?.providers;
}

/** Shown while a page's data is on its way, so "nothing yet" is never a guess. */
export function Loading(props: { what: string }) {
  return (
    <div className="empty" aria-busy="true">
      Loading {props.what}…
    </div>
  );
}

/** A load that failed: what, why, and a way to try again. */
export function LoadError(props: { what: string; error: unknown; retry: () => void }) {
  return (
    <div className="card empty-hero" role="alert">
      <h3>Could not load {props.what}</h3>
      <p>{capital(why(props.error))}.</p>
      <button type="button" className="btn" onClick={props.retry}>
        Try again
      </button>
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function NotFound() {
  return (
    <>
      <PageHead title="Page not found" />
      <div className="card empty-hero">
        <h3>There is no page at this address</h3>
        <p>The link may be mistyped, or the page has moved.</p>
        <Link to="/" className="btn">
          Back to overview
        </Link>
      </div>
    </>
  );
}

/** Keeps a page that throws from blanking the whole console. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <PageHead title="Something went wrong" />
        <div className="card empty-hero" role="alert">
          <h3>This page could not be shown</h3>
          <p>Reload to try again. The rest of the console still works.</p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </>
    );
  }
}

const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];
const OTHER = "var(--c6)";

/** Bars per day, stacked by the top models; the rest are "Other". */
export function StackedBars(props: { series: Day[]; metric: "calls" | "tokens" }) {
  const { series, metric } = props;
  const totals = new Map<string, number>();
  for (const d of series)
    for (const [m, v] of Object.entries(d.byModel)) totals.set(m, (totals.get(m) ?? 0) + v[metric]);
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COLORS.length)
    .map(([m]) => m);
  const hasOther = totals.size > top.length;
  const stacks = series.map((d) => {
    const parts = top.map((m) => d.byModel[m]?.[metric] ?? 0);
    const other = Object.entries(d.byModel)
      .filter(([m]) => !top.includes(m))
      .reduce((n, [, v]) => n + v[metric], 0);
    return { day: d.day, parts, other, total: parts.reduce((a, b) => a + b, 0) + other };
  });
  const max = Math.max(1, ...stacks.map((s) => s.total));
  const W = 1000;
  const H = 180;
  const gap = series.length > 40 ? 2 : 6;
  const bw = (W - gap * (series.length - 1)) / series.length;
  const [hover, setHover] = useState<number | null>(null);
  const h = hover === null ? null : stacks[hover];
  return (
    <>
      <div className="chart">
        <div className="small subtle" style={{ height: 18 }}>
          {h
            ? `${h.day} · ${compact(h.total)} ${metric}`
            : `Peak ${compact(max === 1 && stacks.every((s) => s.total === 0) ? 0 : max)} ${metric} a day`}
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${metric} per day`}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={H * f}
              y2={H * f}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {stacks.map((s, i) => {
            const x = i * (bw + gap);
            let y = H;
            const segs = [
              ...s.parts.map((v, j) => ({ v, c: COLORS[j] })),
              { v: s.other, c: OTHER },
            ];
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows the day's total, also in the table
              <g key={s.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={x} y={0} width={bw} height={H} fill="transparent" />
                {s.total === 0 && (
                  <rect x={x} y={H - 2} width={bw} height={2} fill="var(--border)" />
                )}
                {segs.map((seg) => {
                  if (seg.v === 0) return null;
                  const hh = (seg.v / max) * (H - 4);
                  y -= hh;
                  return (
                    <rect
                      key={seg.c}
                      x={x}
                      y={y}
                      width={bw}
                      height={hh}
                      fill={seg.c}
                      rx="1.5"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
        <div className="chart-axis">
          <span>{series[0]?.day.slice(5)}</span>
          <span>{series.at(-1)?.day.slice(5)}</span>
        </div>
      </div>
      {top.length > 0 && (
        <div className="legend">
          {top.map((m, j) => (
            <span key={m}>
              <i style={{ background: COLORS[j] }} />
              {m}
            </span>
          ))}
          {hasOther && (
            <span>
              <i style={{ background: OTHER }} />
              Other
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** A monogram tile in a colour derived from the name (no third-party logos). */
export function ProviderLogo(props: { label: string; size?: number }) {
  let h = 0;
  for (const ch of props.label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const size = props.size ?? 32;
  return (
    <span
      className="prov-logo"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        color: `hsl(${h} 55% 38%)`,
        background: `hsl(${h} 70% 95%)`,
        borderColor: `hsl(${h} 45% 86%)`,
      }}
    >
      {props.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)}
    </span>
  );
}

export const icons = {
  home: <path d="M3 10.5 12 3l9 7.5V21H15v-6H9v6H3z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  book: <path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5a3 3 0 0 0-3 3" />,
  check: (
    <>
      <path d="M9 11l3 3 8-8" />
      <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
    </>
  ),
  layers: <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />,
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  puzzle: (
    <path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7z" />
  ),
  file: <path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6" />,
};

export function Icon(props: { name: keyof typeof icons }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[props.name]}
    </svg>
  );
}
