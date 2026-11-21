import { lazy, type ReactNode } from "react";
import { loadKeys } from "./account-keys.js";
import type { Me } from "./api.js";
import { Activity } from "./pages/Activity.js";
import { Agents } from "./pages/Agents.js";
import { BudgetPage } from "./pages/Budget.js";
import { Findings } from "./pages/Findings.js";
import { Insights } from "./pages/Insights.js";
import { Keys } from "./pages/Keys.js";
import { Memory } from "./pages/Memory.js";
import { Overview } from "./pages/Overview.js";
import { Plugins } from "./pages/Plugins.js";
import { Repositories } from "./pages/Repositories.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { Sessions } from "./pages/Sessions.js";
import { Settings } from "./pages/Settings.js";
import { type icons, loadProviders, NotFound } from "./ui.js";

// Pages few visits open load on demand, so the sign-in screen and the
// console's first page do not wait for them (audit C11).
const Defaults = lazy(() => import("./pages/Defaults.js").then((m) => ({ default: m.Defaults })));
const Device = lazy(() => import("./pages/Device.js").then((m) => ({ default: m.Device })));
const ReviewDetail = lazy(() =>
  import("./pages/ReviewDetail.js").then((m) => ({ default: m.ReviewDetail })),
);

// The signed-in pages, in the sidebar's order: one table drives the
// sidebar, the page title and which page a path shows. An unknown path is
// a 404, not the overview.

export type NavGroup = "Console" | "Configure" | "Account";

export type Route = {
  /** The path, with `:param` for a segment the page takes. */
  path: string;
  /** In the sidebar, under group, and the page title; absent: reached by link only. */
  nav?: { label: string; icon: keyof typeof icons; group: NavGroup };
  /** Edits the account's preferences: the save bar and its draft apply. */
  prefs?: true;
  /**
   * What the page reads that can start before /me answers, in a browser
   * that was signed in, so it is not a second round trip after it (audit
   * C11); a 401 means what /me's does.
   */
  loads?: readonly (() => Promise<unknown>)[];
  page: (me: Me, params: string[]) => ReactNode;
};

const keysAndProviders = [loadKeys, loadProviders] as const;

const ROUTES: readonly Route[] = [
  {
    path: "/",
    nav: { label: "Overview", icon: "home", group: "Console" },
    loads: keysAndProviders,
    page: (me) => <Overview login={me.login} />,
  },
  {
    path: "/activity",
    nav: { label: "Activity", icon: "activity", group: "Console" },
    page: () => <Activity />,
  },
  {
    path: "/reviews",
    nav: { label: "Reviews", icon: "check", group: "Console" },
    page: () => <Reviews />,
  },
  { path: "/reviews/:id", page: (_me, [id]) => <ReviewDetail id={id ?? ""} /> },
  {
    path: "/findings",
    nav: { label: "Findings", icon: "list", group: "Console" },
    page: () => <Findings />,
  },
  {
    path: "/insights",
    nav: { label: "Review quality", icon: "activity", group: "Console" },
    page: () => <Insights />,
  },
  {
    path: "/repositories",
    nav: { label: "Repositories", icon: "layers", group: "Console" },
    page: () => <Repositories />,
  },
  {
    path: "/keys",
    nav: { label: "Provider keys", icon: "key", group: "Configure" },
    loads: keysAndProviders,
    page: () => <Keys />,
  },
  {
    path: "/agents",
    nav: { label: "Agents", icon: "layers", group: "Configure" },
    prefs: true,
    loads: keysAndProviders,
    page: () => <Agents />,
  },
  // The page's name before per-agent settings; old links still work.
  { path: "/models", prefs: true, loads: keysAndProviders, page: () => <Agents /> },
  {
    path: "/review-settings",
    nav: { label: "Review settings", icon: "sliders", group: "Configure" },
    prefs: true,
    page: () => <ReviewSettings />,
  },
  {
    path: "/rules",
    nav: { label: "Rules", icon: "list", group: "Configure" },
    prefs: true,
    page: () => <Rules />,
  },
  {
    path: "/plugins",
    nav: { label: "Plugins", icon: "puzzle", group: "Configure" },
    prefs: true,
    page: () => <Plugins />,
  },
  {
    path: "/memory",
    nav: { label: "Memory", icon: "check", group: "Configure" },
    page: () => <Memory />,
  },
  {
    path: "/budget",
    nav: { label: "Budget", icon: "sliders", group: "Configure" },
    page: () => <BudgetPage />,
  },
  {
    path: "/defaults",
    nav: { label: "Defaults & history", icon: "file", group: "Configure" },
    prefs: true,
    loads: keysAndProviders,
    page: () => <Defaults />,
  },
  {
    path: "/sessions",
    nav: { label: "CLI & sessions", icon: "terminal", group: "Account" },
    page: () => <Sessions />,
  },
  {
    path: "/settings",
    nav: { label: "Settings", icon: "settings", group: "Account" },
    page: (me) => <Settings me={me} />,
  },
  { path: "/device", page: () => <Device /> },
];

/** The sidebar: each group's routes, in the table's order. */
export const NAV_GROUPS: { label: NavGroup; routes: (Route & { nav: object })[] }[] = (
  ["Console", "Configure", "Account"] as const
).map((label) => ({
  label,
  routes: ROUTES.filter((r): r is Route & { nav: object } => r.nav?.group === label),
}));

/** A path segment, or null when it is not valid percent-encoding. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The route a path shows, with its params; undefined is a 404. */
export function matchRoute(path: string): { route: Route; params: string[] } | undefined {
  const parts = path.split("/");
  for (const route of ROUTES) {
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: string[] = [];
    const fits = pattern.every((p, i) => {
      const part = parts[i] ?? "";
      if (!p.startsWith(":")) return p === part;
      const value = decode(part);
      if (!value) return false;
      params.push(value);
      return true;
    });
    if (fits) return { route, params };
  }
  return undefined;
}

export function pageFor(path: string, me: Me): ReactNode {
  const found = matchRoute(path);
  return found ? found.route.page(me, found.params) : <NotFound />;
}
