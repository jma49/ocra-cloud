import type { ReactNode } from "react";
import { loadKeys } from "./account-keys.js";
import type { Me } from "./api.js";
import { prefetch } from "./api.js";
import { isLazyPage, lazyPage } from "./lazy-page.js";
import { Inbox } from "./pages/Inbox.js";
import { pullReads } from "./pull/reads.js";
import { loadAhead } from "./stale-build.js";
import { loadProviders } from "./ui.js";

// Every page but the inbox, the first one, loads on demand: hovering a link
// to it (or the browser's idle time) loads its code before the click.
const Activity = lazyPage(() => import("./pages/Activity.js"), "Activity");
const Agents = lazyPage(() => import("./pages/Agents.js"), "Agents");
const ApiTokens = lazyPage(() => import("./pages/ApiTokens.js"), "ApiTokens");
const AuditLog = lazyPage(() => import("./pages/AuditLog.js"), "AuditLog");
const AutoReview = lazyPage(() => import("./pages/AutoReview.js"), "AutoReview");
const Automations = lazyPage(() => import("./pages/Automations.js"), "Automations");
const BudgetPage = lazyPage(() => import("./pages/Budget.js"), "BudgetPage");
const CodeGraph = lazyPage(() => import("./pages/CodeGraph.js"), "CodeGraph");
const CodeGraphs = lazyPage(() => import("./pages/CodeGraphs.js"), "CodeGraphs");
const Defaults = lazyPage(() => import("./pages/Defaults.js"), "Defaults");
const Device = lazyPage(() => import("./pages/Device.js"), "Device");
const Findings = lazyPage(() => import("./pages/Findings.js"), "Findings");
const Insights = lazyPage(() => import("./pages/Insights.js"), "Insights");
const Keys = lazyPage(() => import("./pages/Keys.js"), "Keys");
const Learnings = lazyPage(() => import("./pages/Learnings.js"), "Learnings");
const Live = lazyPage(() => import("./pages/Live.js"), "Live");
const LivePage = lazyPage(() => import("./pages/LivePage.js"), "LivePage");
const Memory = lazyPage(() => import("./pages/Memory.js"), "Memory");
const Notifications = lazyPage(() => import("./pages/Notifications.js"), "Notifications");
const Overview = lazyPage(() => import("./pages/Overview.js"), "Overview");
const Plugins = lazyPage(() => import("./pages/Plugins.js"), "Plugins");
const PullPage = lazyPage(() => import("./pages/PullPage.js"), "PullPage");
const ReleaseNotes = lazyPage(() => import("./pages/ReleaseNotes.js"), "ReleaseNotes");
const RepoConfig = lazyPage(() => import("./pages/RepoConfig.js"), "RepoConfig");
const Repositories = lazyPage(() => import("./pages/Repositories.js"), "Repositories");
const ReviewDetail = lazyPage(() => import("./pages/ReviewDetail.js"), "ReviewDetail");
const ReviewSettings = lazyPage(() => import("./pages/ReviewSettings.js"), "ReviewSettings");
const Reviews = lazyPage(() => import("./pages/Reviews.js"), "Reviews");
const Rules = lazyPage(() => import("./pages/Rules.js"), "Rules");
const Sessions = lazyPage(() => import("./pages/Sessions.js"), "Sessions");
const Settings = lazyPage(() => import("./pages/Settings.js"), "Settings");

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
  /** What the page bar names a page under its place by, where it is no tab of it. */
  crumb?: string;
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
  /**
   * The API paths the page reads first, given its params, started with the
   * navigation rather than after the page's code arrives and renders; the
   * first is the one a hover may start too.
   */
  reads?: (params: string[]) => readonly string[];
  page: (me: Me, params: string[]) => ReactNode;
};

const keysAndProviders = [loadKeys, loadProviders] as const;
const INBOX_READS = ["/platforms/pulls", "/pull-views"] as const;
const graphsKept = (me: Me) => me.codeGraphs !== "off";

const ROUTES: readonly Route[] = [
  {
    path: "/",
    place: "inbox",
    tab: "Inbox",
    reads: () => INBOX_READS,
    page: (me) => <Inbox me={me} />,
  },
  // The inbox's address before it was the console's first page.
  { path: "/pulls", place: "inbox", page: (me) => <Inbox me={me} /> },
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
    reads: ([id = ""]) => [`/reviews/${encodeURIComponent(id)}`],
    page: (me, [id]) => <ReviewDetail id={id ?? ""} graphs={graphsKept(me)} />,
  },
  {
    path: "/pull/:platform/:repo*/:number",
    place: "inbox",
    reads: ([platform = "", repo = "", number = ""]) => pullReads({ platform, repo, number }),
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
    path: "/code-graphs/:id",
    place: "repositories",
    crumb: "Code graph",
    shown: graphsKept,
    reads: () => ["/graphs/repos"],
    page: (_me, [id]) => <CodeGraph id={id ?? ""} />,
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
    page: (me) => <Overview me={me} />,
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
    page: (me) => <Notifications platforms={me.platforms} enrolls={me.autoReview} />,
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

/**
 * Gets a page ready before it opens: its code, and the reads it starts with.
 * A hover (`intent: "hover"`) starts only the first read, since most
 * hovers are not followed by a click and the reads of a pull request each
 * cost the platform a call; a press or a navigation starts them all.
 */
export function prefetchRoute(path: string, me: Me, intent: "hover" | "open"): void {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) return;
  const found = matchRoute(url.pathname, me);
  if (!found) return;
  const { route, params } = found;
  loadCode(route.page(me, params));
  const reads = route.reads?.(params) ?? [];
  for (const read of intent === "hover" ? reads.slice(0, 1) : reads) prefetch(read);
  if (intent === "open") for (const load of route.loads ?? []) load().catch(() => {});
}

function loadCode(page: ReactNode): void {
  if (page && typeof page === "object" && "type" in page && isLazyPage(page.type)) {
    loadAhead(page.type.preload);
  }
}

// The pages most visits go on to open from the inbox.
const LIKELY = new Set([
  "/pull/:platform/:repo*/:number",
  "/reviews/:id",
  "/reviews",
  "/findings",
  "/repositories",
]);

/** Loads the likely pages' code while the browser is idle, so their first open waits on no download. */
export function loadLikelyPages(me: Me): void {
  for (const route of ROUTES) if (LIKELY.has(route.path)) loadCode(route.page(me, []));
}
