import { lazy, type ReactNode } from "react";
import { loadKeys } from "./account-keys.js";
import type { Me } from "./api.js";
import { Activity } from "./pages/Activity.js";
import { Agents } from "./pages/Agents.js";
import { ApiTokens } from "./pages/ApiTokens.js";
import { AuditLog } from "./pages/AuditLog.js";
import { BudgetPage } from "./pages/Budget.js";
import { CodeGraphs } from "./pages/CodeGraphs.js";
import { Findings } from "./pages/Findings.js";
import { Inbox } from "./pages/Inbox.js";
import { Insights } from "./pages/Insights.js";
import { Keys } from "./pages/Keys.js";
import { Memory } from "./pages/Memory.js";
import { Notifications } from "./pages/Notifications.js";
import { Overview } from "./pages/Overview.js";
import { Plugins } from "./pages/Plugins.js";
import { ReleaseNotes } from "./pages/ReleaseNotes.js";
import { Repositories } from "./pages/Repositories.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { Sessions } from "./pages/Sessions.js";
import { Settings } from "./pages/Settings.js";
import { loadProviders, NotFound } from "./ui.js";

// Pages few visits open load on demand, so the sign-in screen and the
// console's first page do not wait for them (audit C11).
const Automations = lazy(() =>
  import("./pages/Automations.js").then((m) => ({ default: m.Automations })),
);
const Learnings = lazy(() =>
  import("./pages/Learnings.js").then((m) => ({ default: m.Learnings })),
);
const RepoConfig = lazy(() =>
  import("./pages/RepoConfig.js").then((m) => ({ default: m.RepoConfig })),
);
const AutoReview = lazy(() =>
  import("./pages/AutoReview.js").then((m) => ({ default: m.AutoReview })),
);
const Defaults = lazy(() => import("./pages/Defaults.js").then((m) => ({ default: m.Defaults })));
const Device = lazy(() => import("./pages/Device.js").then((m) => ({ default: m.Device })));
const PullPage = lazy(() => import("./pages/PullPage.js").then((m) => ({ default: m.PullPage })));
const Live = lazy(() => import("./pages/Live.js").then((m) => ({ default: m.Live })));
const LivePage = lazy(() => import("./pages/LivePage.js").then((m) => ({ default: m.LivePage })));
const ReviewDetail = lazy(() =>
  import("./pages/ReviewDetail.js").then((m) => ({ default: m.ReviewDetail })),
);

// The signed-in pages: one table drives the rail's places, each place's
// tabs, the settings list, the page title and which page a path shows. An
// unknown path is a 404, not the inbox.

export type Place = "inbox" | "reviews" | "findings" | "repositories" | "insights" | "settings";
export type SettingsGroup = "Review" | "Models & spend" | "Account";

export type Route = {
  /** The path, with `:param` for a segment the page takes. */
  path: string;
  /** The rail's place the page belongs to; absent: no place is lit. */
  place?: Place;
  /** Its name in the place's tabs (or the settings list) and the page title; absent: reached by link only. */
  tab?: string;
  /** Where a settings page sits in the settings list. */
  group?: SettingsGroup;
  /** Shown only for whom it holds; absent: for everyone. */
  shown?: (me: Me) => boolean;
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
const graphsKept = (me: Me) => me.codeGraphs !== "off";

const ROUTES: readonly Route[] = [
  { path: "/", place: "inbox", tab: "Inbox", page: () => <Inbox /> },
  // The inbox's address before it was the console's first page.
  { path: "/pulls", place: "inbox", page: () => <Inbox /> },
  {
    path: "/reviews",
    place: "reviews",
    tab: "Reviews",
    page: (me) => <Reviews runner={me.autoReview} />,
  },
  { path: "/activity", place: "reviews", tab: "Activity", page: () => <Activity /> },
  { path: "/live", place: "reviews", tab: "Live", page: () => <Live /> },
  { path: "/live/:id", place: "reviews", page: (_me, [id]) => <LivePage id={id ?? ""} /> },
  {
    path: "/reviews/:id",
    place: "reviews",
    page: (me, [id]) => <ReviewDetail id={id ?? ""} graphs={graphsKept(me)} />,
  },
  {
    path: "/pull/:platform/:repo*/:number",
    place: "inbox",
    page: (me, [platform, repo, number]) => (
      <PullPage
        platform={platform ?? ""}
        repo={repo ?? ""}
        number={number ?? ""}
        runner={me.autoReview}
      />
    ),
  },
  {
    path: "/findings",
    place: "findings",
    tab: "Findings",
    page: (me) => <Findings runner={me.autoReview} />,
  },
  {
    path: "/repositories",
    place: "repositories",
    tab: "Repositories",
    page: (me) => <Repositories me={me} />,
  },
  {
    path: "/code-graphs",
    place: "repositories",
    tab: "Code graphs",
    shown: graphsKept,
    page: (me) => <CodeGraphs policy={me.codeGraphs} platforms={me.platforms} />,
  },
  {
    path: "/auto-review",
    place: "repositories",
    tab: "Auto review",
    shown: (me) => me.autoReview,
    page: (me) => <AutoReview platforms={me.platforms} />,
  },
  { path: "/learnings", place: "repositories", tab: "Learnings", page: () => <Learnings /> },
  {
    path: "/review-config",
    place: "repositories",
    tab: "Review config",
    page: () => <RepoConfig />,
  },
  { path: "/memory", place: "repositories", tab: "Memory", page: () => <Memory /> },
  {
    path: "/release-notes",
    place: "repositories",
    tab: "Release notes",
    page: () => <ReleaseNotes />,
  },
  {
    path: "/insights",
    place: "insights",
    tab: "Overview",
    page: (me) => <Insights runner={me.autoReview} platforms={me.platforms} />,
  },
  {
    path: "/usage",
    place: "insights",
    tab: "Usage",
    loads: keysAndProviders,
    page: () => <Overview />,
  },
  {
    path: "/agents",
    place: "settings",
    tab: "Agents & models",
    group: "Review",
    prefs: true,
    loads: keysAndProviders,
    page: () => <Agents />,
  },
  // The page's name before per-agent settings; old links still work.
  {
    path: "/models",
    place: "settings",
    prefs: true,
    loads: keysAndProviders,
    page: () => <Agents />,
  },
  {
    path: "/review-settings",
    place: "settings",
    tab: "Review settings",
    group: "Review",
    prefs: true,
    page: () => <ReviewSettings />,
  },
  {
    path: "/rules",
    place: "settings",
    tab: "Rules",
    group: "Review",
    prefs: true,
    page: () => <Rules />,
  },
  {
    path: "/automations",
    place: "settings",
    tab: "Automations",
    group: "Review",
    page: (me) => <Automations me={me} />,
  },
  {
    path: "/plugins",
    place: "settings",
    tab: "Plugins",
    group: "Review",
    prefs: true,
    page: () => <Plugins />,
  },
  {
    path: "/defaults",
    place: "settings",
    tab: "Defaults & history",
    group: "Review",
    prefs: true,
    loads: keysAndProviders,
    page: () => <Defaults />,
  },
  {
    path: "/keys",
    place: "settings",
    tab: "Provider keys",
    group: "Models & spend",
    loads: keysAndProviders,
    page: () => <Keys />,
  },
  {
    path: "/budget",
    place: "settings",
    tab: "Budget",
    group: "Models & spend",
    page: () => <BudgetPage />,
  },
  {
    path: "/settings",
    place: "settings",
    tab: "Account & privacy",
    group: "Account",
    page: (me) => <Settings me={me} />,
  },
  {
    path: "/notifications",
    place: "settings",
    tab: "Notifications",
    group: "Account",
    page: (me) => <Notifications platforms={me.platforms} />,
  },
  {
    path: "/sessions",
    place: "settings",
    tab: "CLI & sessions",
    group: "Account",
    page: () => <Sessions />,
  },
  {
    path: "/tokens",
    place: "settings",
    tab: "API tokens",
    group: "Account",
    page: () => <ApiTokens />,
  },
  {
    path: "/audit",
    place: "settings",
    tab: "Audit log",
    group: "Account",
    page: () => <AuditLog />,
  },
  { path: "/device", page: () => <Device /> },
];

type Tabbed = Route & { tab: string };
const visible =
  (me: Me) =>
  (r: Route): r is Tabbed =>
    r.tab !== undefined && (r.shown?.(me) ?? true);

/** A place's tabs for whoever is signed in, in the table's order. */
export function placeTabs(place: Place, me: Me): Tabbed[] {
  return ROUTES.filter((r) => r.place === place).filter(visible(me));
}

/** The settings list: each group's pages, in the table's order. */
export function settingsGroups(me: Me): { label: SettingsGroup; routes: Tabbed[] }[] {
  return (["Review", "Models & spend", "Account"] as const).map((label) => ({
    label,
    routes: ROUTES.filter((r) => r.group === label).filter(visible(me)),
  }));
}

/** Where a place opens: its first tab. */
export function placeHome(place: Place): string {
  return ROUTES.find((r) => r.place === place && r.tab)?.path ?? "/";
}

/**
 * Pairs a route's segments with a path's; a `:name*` segment takes one or
 * more of them, joined by "/", so a repository's path matches written out
 * (`octo/api`, `group/sub/project`) as well as encoded. null: no fit.
 */
function spread(pattern: string[], parts: string[]): [string, string][] | null {
  const star = pattern.findIndex((p) => p.endsWith("*"));
  const extra = parts.length - pattern.length;
  if (star < 0) return extra === 0 ? pattern.map((p, i) => [p, parts[i] ?? ""]) : null;
  if (extra < 0) return null;
  return pattern.map((p, i): [string, string] => {
    if (i < star) return [p, parts[i] ?? ""];
    if (i > star) return [p, parts[i + extra] ?? ""];
    return [p.slice(0, -1), parts.slice(star, star + extra + 1).join("/")];
  });
}

/** A path segment, or null when it is not valid percent-encoding. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The route a path shows, with its params; undefined is a 404, as is a page
 * not shown for whoever is signed in (`me`), so its address does not render
 * a page whose server side is absent.
 */
export function matchRoute(path: string, me?: Me): { route: Route; params: string[] } | undefined {
  const parts = path.split("/");
  for (const route of ROUTES) {
    const segments = spread(route.path.split("/"), parts);
    if (!segments) continue;
    const params: string[] = [];
    const fits = segments.every(([p, part]) => {
      if (!p.startsWith(":")) return p === part;
      const value = decode(part);
      if (!value) return false;
      params.push(value);
      return true;
    });
    if (fits) return me && route.shown && !route.shown(me) ? undefined : { route, params };
  }
  return undefined;
}

export function pageFor(path: string, me: Me): ReactNode {
  const found = matchRoute(path, me);
  return found ? found.route.page(me, found.params) : <NotFound />;
}
