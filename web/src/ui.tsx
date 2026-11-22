import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { SignInMethod } from "../../src/shared/index.js";
import { api, type Day, needsSignIn, type ProviderInfo, why } from "./api.js";
import { compact } from "./format.js";
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

/**
 * Loads once per change of deps. A change of deps starts again from no
 * data, so a page never shows the previous period's while the new one
 * loads; reload() keeps what is shown until the new answer arrives.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error: unknown; loading: boolean }>({
    error: null,
    loading: true,
  });
  const [n, setN] = useState(0);
  const loadedFor = useRef(n);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    let live = true;
    // A reload keeps what is shown; new deps start from nothing.
    const reloading = n !== loadedFor.current;
    loadedFor.current = n;
    setState((s) => (reloading ? { ...s, loading: true } : { error: null, loading: true }));
    load().then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error) => {
        if (live) setState((s) => ({ ...s, error, loading: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

/**
 * A change the page asks for (a delete, a save): run() resolves to the
 * result, or undefined when it failed, and error holds why until the next run.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await latest.current(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error };
}

// The providers list is the same for everyone and changes only with a
// deploy: one request per page load, shared by every page.
let providersOnce: Promise<ProviderInfo[]> | undefined;

/** The providers the gateway forwards (public; the same list the CLI reads). */
export function loadProviders(): Promise<ProviderInfo[]> {
  providersOnce ??= api<{ providers: ProviderInfo[] }>("/providers").then(
    (r) => r.providers,
    (e) => {
      // A failure is not kept: the next page asks again.
      providersOnce = undefined;
      throw e;
    },
  );
  return providersOnce;
}

/** Forgets the shared providers list (for tests). */
export function forgetProviders(): void {
  providersOnce = undefined;
}

export function useProviders(): ProviderInfo[] | undefined {
  return useLoad(loadProviders).data;
}

// How this deployment signs people in changes only with its settings: one
// request per page load, as for the providers.
let methodsOnce: Promise<SignInMethod[]> | undefined;

function loadSignInMethods(): Promise<SignInMethod[]> {
  methodsOnce ??= api<{ methods: SignInMethod[] }>("/auth/methods").then(
    (r) => r.methods,
    (e) => {
      methodsOnce = undefined;
      throw e;
    },
  );
  return methodsOnce;
}

export function useSignInMethods(): SignInMethod[] | undefined {
  return useLoad(loadSignInMethods).data;
}

/** Where a sign-in through `method` starts, coming back to `next`. */
export const signInHref = (method: SignInMethod, next?: string) =>
  `/api/auth/${method.id}/login${next ? `?next=${encodeURIComponent(next)}` : ""}`;

/** Shown while a page's data is on its way, so "nothing yet" is never a guess. */
export function Loading(props: { what: string }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading {props.what}…</span>
      <span className="skeleton-bar" />
      <span className="skeleton-bar" />
      <span className="skeleton-bar" />
    </div>
  );
}

/** A load that failed: what, why, and a way to try again. */
export function LoadError(props: { what: string; error: unknown; retry: () => void }) {
  return (
    <div className="card empty-hero" role="alert">
      <h3>Could not load {props.what}</h3>
      <p>{capital(why(props.error))}.</p>
      <Button type="button" variant="outline" onClick={props.retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * An action that failed: what, why, and a fresh sign-in when that is what
 * it needs (audit C7), which comes back to this page.
 */
export function ActionError(props: { what: string; error: unknown }) {
  const method = useSignInMethods()?.[0];
  return (
    <p className="error" role="alert">
      Could not {props.what}: {why(props.error)}.{" "}
      {needsSignIn(props.error) && method && (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={signInHref(method, location.pathname)}
        >
          Sign in again
        </a>
      )}
    </p>
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
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
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
          <Button type="button" variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
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
        <div className="small subtle chart-caption">
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

/**
 * A monogram tile printed in ink (no third-party logos, and no colour per
 * provider: the landing page's look has one signal colour and no other).
 */
export function ProviderLogo(props: { label: string; size?: number }) {
  const size = props.size ?? 32;
  return (
    <span className="prov-logo" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {props.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)}
    </span>
  );
}
