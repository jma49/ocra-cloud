import type { LucideIcon } from "lucide-react";
import MapPinOff from "lucide-react/icons/map-pin-off";
import TriangleAlert from "lucide-react/icons/triangle-alert";
import {
  Component,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { SignInMethod } from "../../src/shared/index.js";
import { api, type Day, needsSignIn, type ProviderInfo, why } from "./api.js";
import { DayChart } from "./charts/day-chart.js";
import { compact } from "./format.js";
import { usePickedGlide } from "./glide.js";
import { Link } from "./router.js";

/** Set by the frame on a place's own tabs, whose bar already names the page. */
export const NamedByBar = createContext(false);

/**
 * The page's title, its sentence and its actions. Under a bar that names the page, the title is
 * only for screen readers, the sentence goes, and the actions keep their line; a `note` (what a
 * page does with the user's code or data) stays as a quiet line. A `standalone` head (an error,
 * a missing page) always shows.
 */
export function PageHead(props: {
  title: string;
  sub?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  standalone?: boolean;
}) {
  const named = useContext(NamedByBar) && !props.standalone;
  if (named)
    return (
      <div className={`page-head named${props.actions ? "" : " bare"}`}>
        <div>
          <h1 className="sr-only">{props.title}</h1>
          {props.note && <p className="page-note">{props.note}</p>}
        </div>
        {props.actions}
      </div>
    );
  return (
    <div className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <p>{props.sub}</p>}
        {props.note && <p>{props.note}</p>}
      </div>
      {props.actions}
    </div>
  );
}

/** One choice of a few, as toggle buttons (not tabs: no panels follow). */
export function Seg<T extends string | number>(props: {
  value: T;
  /** With an icon, an option shows only it, its label as its name and in a tooltip. */
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  usePickedGlide(group, "[data-pressed]");
  return (
    <ToggleGroup
      ref={group}
      className="seg glide"
      size="sm"
      aria-label={props.label}
      value={[String(props.value)]}
      onValueChange={(values) => {
        const picked = props.options.find((o) => String(o.value) === values[0]);
        if (picked) props.onChange(picked.value);
      }}
    >
      {props.options.map((o) => {
        if (!o.icon) {
          return (
            <ToggleGroupItem key={String(o.value)} value={String(o.value)}>
              {o.label}
            </ToggleGroupItem>
          );
        }
        const Icon = o.icon;
        return (
          <Tooltip key={String(o.value)}>
            <TooltipTrigger
              render={<ToggleGroupItem value={String(o.value)} aria-label={o.label} />}
            >
              <Icon size={14} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{o.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </ToggleGroup>
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
 * Calls `reload` every `ms` while `active` and the tab is in view: a hidden
 * tab spends none of the platforms' allowance, and catches up when shown.
 */
export function usePoll(active: boolean, reload: () => void, ms: number) {
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") reload();
    };
    const timer = setInterval(tick, ms);
    const shown = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [active, reload, ms]);
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

export { EmptyState };

/** Code shown as typed; it scrolls sideways, so the keyboard can reach and scroll it. */
export function CodeBlock(props: { label: string; children: string }) {
  return (
    <section aria-label={props.label}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so the keyboard can scroll it */}
      <pre className="codeblock" tabIndex={0}>
        {props.children}
      </pre>
    </section>
  );
}

/**
 * Shown while data is on its way, in the frame the data will fill, so
 * nothing moves when it lands and "nothing yet" is never a guess. Inside a
 * card already (`inCard`), it adds no card of its own, as `LoadError`.
 */
export function Loading(props: { what: string; inCard?: boolean; rows?: number }) {
  const state = (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading {props.what}…</span>
      {Array.from({ length: props.rows ?? 3 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
        <span key={i} className="skeleton-row">
          <span className="skeleton-bar" />
          <span className="skeleton-bar" />
        </span>
      ))}
    </div>
  );
  return props.inCard ? state : <div className="card">{state}</div>;
}

/** A part of a card with nothing in it yet: one quiet line, where a whole view gets `EmptyState`. */
export function EmptyNote(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

/**
 * A load that failed: what, why, and a way to try again. Inside a card
 * already (`inCard`), it adds no card of its own: cards do not nest.
 */
export function LoadError(props: {
  what: string;
  error: unknown;
  retry: () => void;
  inCard?: boolean;
}) {
  const state = (
    <EmptyState
      role="alert"
      icon={TriangleAlert}
      title={`Could not load ${props.what}`}
      action={
        <Button type="button" variant="outline" onClick={props.retry}>
          Try again
        </Button>
      }
    >
      {capital(why(props.error).replace(/; try again$/, ""))}.
    </EmptyState>
  );
  return props.inCard ? state : <div className="card">{state}</div>;
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
        <Button
          variant="outline"
          size="sm"
          render={<a href={signInHref(method, location.pathname)} />}
        >
          Sign in again
        </Button>
      )}
    </p>
  );
}

// The product name starts lower case ("ocra Cloud had an error").
const capital = (s: string) => (s.startsWith("ocra") ? s : s.charAt(0).toUpperCase() + s.slice(1));

export function NotFound() {
  return (
    <>
      <PageHead title="Page not found" standalone />
      <div className="card">
        <EmptyState
          icon={MapPinOff}
          title="There is no page at this address"
          action={
            <Button variant="outline" render={<Link to="/" />}>
              Back to overview
            </Button>
          }
        >
          The link may be mistyped, or the page has moved.
        </EmptyState>
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
        <PageHead title="Something went wrong" standalone />
        <div className="card">
          <EmptyState
            role="alert"
            icon={TriangleAlert}
            title="This page could not be shown"
            action={
              <Button type="button" variant="outline" onClick={() => location.reload()}>
                Reload
              </Button>
            }
          >
            Reload to try again. The rest of the console still works.
          </EmptyState>
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
  const others = series.map((d) =>
    Object.entries(d.byModel)
      .filter(([m]) => !top.includes(m))
      .reduce((n, [, v]) => n + v[metric], 0),
  );
  return (
    <DayChart
      label={metric === "calls" ? "Requests per day, by model" : "Tokens per day, by model"}
      kind="bars"
      days={series.map((d) => d.day)}
      format={compact}
      legend
      series={[
        ...top.map((m, j) => ({
          name: m,
          color: COLORS[j] ?? OTHER,
          values: series.map((d) => d.byModel[m]?.[metric] ?? 0),
        })),
        ...(others.some((n) => n > 0) ? [{ name: "Other", color: OTHER, values: others }] : []),
      ]}
    />
  );
}

/** A number on a card; with `to`, the card opens the list the number counts. */
export function Stat(props: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  to?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.children}
      {props.note !== undefined && <div className="stat-note">{props.note}</div>}
    </>
  );
  return props.to ? (
    <Link to={props.to} className="card stat stat-link">
      {body}
    </Link>
  ) : (
    <div className="card stat">{body}</div>
  );
}
