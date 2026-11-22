import type { LucideIcon } from "lucide-react";
import Bell from "lucide-react/icons/bell";
import BookOpen from "lucide-react/icons/book-open";
import Brain from "lucide-react/icons/brain";
import ChartColumn from "lucide-react/icons/chart-column";
import Coins from "lucide-react/icons/coins";
import Flag from "lucide-react/icons/flag";
import Folder from "lucide-react/icons/folder";
import GitPullRequest from "lucide-react/icons/git-pull-request";
import History from "lucide-react/icons/history";
import Inbox from "lucide-react/icons/inbox";
import KeyRound from "lucide-react/icons/key-round";
import ListChecks from "lucide-react/icons/list-checks";
import Puzzle from "lucide-react/icons/puzzle";
import Settings from "lucide-react/icons/settings";
import SlidersHorizontal from "lucide-react/icons/sliders-horizontal";
import Terminal from "lucide-react/icons/terminal";
import UserRound from "lucide-react/icons/user-round";
import { type ReactElement, type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Me } from "./api.js";
import { AccountMenu } from "./chrome.js";
import { CommandMenu, type CommandSection } from "./command-menu.js";
import { EyesMark } from "./eyes.js";
import { Link } from "./router.js";
import { type Place, placeHome, placeTabs, type Route, settingsGroups } from "./routes.js";
import { DOCS } from "./site.js";

// The signed-in frame: the icon rail of places on the ground, and the open
// page on a panel beside it, headed by where it is and its place's tabs.

const PLACES: { id: Place; label: string; icon: LucideIcon }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "reviews", label: "Reviews", icon: GitPullRequest },
  { id: "findings", label: "Findings", icon: Flag },
  { id: "repositories", label: "Repositories", icon: Folder },
  { id: "insights", label: "Insights", icon: ChartColumn },
];

const SETTINGS_ICONS: Record<string, LucideIcon> = {
  "/agents": Brain,
  "/review-settings": SlidersHorizontal,
  "/rules": ListChecks,
  "/plugins": Puzzle,
  "/defaults": History,
  "/keys": KeyRound,
  "/budget": Coins,
  "/settings": UserRound,
  "/notifications": Bell,
  "/sessions": Terminal,
};

function NavIcon(props: { icon: LucideIcon; size: number }) {
  const Icon = props.icon;
  return <Icon className="nav-icon" size={props.size} strokeWidth={1.75} aria-hidden="true" />;
}

// Below this width the rail is a row across the top (shell.css).
const RAIL_ROW = "(max-width: 760px)";

function useRailRow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = matchMedia(RAIL_ROW);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => matchMedia(RAIL_ROW).matches,
  );
}

/** Names an icon-only rail control beside it, on hover and on keyboard focus. */
function RailTip(props: { label: string; children: ReactElement }) {
  const row = useRailRow();
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side={row ? "bottom" : "right"} sideOffset={8}>
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

function RailLink(props: { to: string; label: string; on: boolean; icon: LucideIcon }) {
  return (
    <RailTip label={props.label}>
      <Link
        to={props.to}
        className={`rail-link${props.on ? " on" : ""}`}
        current={props.on}
        label={props.label}
      >
        <NavIcon icon={props.icon} size={20} />
      </Link>
    </RailTip>
  );
}

function Rail(props: { me: Me; place: Place | undefined }) {
  return (
    <TooltipProvider delay={300}>
      <nav className="rail" aria-label="Console">
        <Link to="/" className="rail-brand" label="ocra">
          <EyesMark size={22} />
        </Link>
        {PLACES.map((p) => (
          <RailLink
            key={p.id}
            to={placeHome(p.id)}
            label={p.label}
            on={props.place === p.id}
            icon={p.icon}
          />
        ))}
        <span className="rail-gap" />
        <RailTip label="Documentation">
          <a
            className="rail-link"
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            aria-label="Documentation"
          >
            <NavIcon icon={BookOpen} size={20} />
          </a>
        </RailTip>
        <RailLink
          to={placeHome("settings")}
          label="Settings"
          on={props.place === "settings"}
          icon={Settings}
        />
        <AccountMenu me={props.me} compact />
      </nav>
    </TooltipProvider>
  );
}

function SettingsNav(props: { me: Me; path: string }) {
  const nav = useRef<HTMLElement>(null);
  // On a phone the nav is one scrolling row: keep the open page's link in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again when the open page changes
  useEffect(() => {
    const el = nav.current;
    const on = el?.querySelector<HTMLElement>(".settings-link.on");
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
  }, [props.path]);
  return (
    <nav className="settings-nav" aria-label="Settings" ref={nav}>
      {settingsGroups(props.me).map((g) => (
        <div key={g.label} className="settings-group">
          <div className="caps">{g.label}</div>
          {g.routes.map((r) => {
            const Icon = SETTINGS_ICONS[r.path] ?? Settings;
            const on = r.path === props.path;
            return (
              <Link
                key={r.path}
                to={r.path}
                className={`settings-link${on ? " on" : ""}`}
                current={on}
              >
                <NavIcon icon={Icon} size={16} />
                {r.tab}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** The bar over the page: the place, and its tabs when it has more than one. */
function PageBar(props: { me: Me; route: Route | undefined; path: string }) {
  const place = PLACES.find((p) => p.id === props.route?.place);
  const tabs = place ? placeTabs(place.id, props.me) : [];
  const here = props.route?.tab ?? (props.route?.path === "/reviews/:id" ? "Review" : undefined);
  const settings = props.route?.place === "settings";
  return (
    <header className="pagebar">
      <span className="crumb">{settings ? "Settings" : (place?.label ?? "ocra")}</span>
      {here && here !== place?.label && (
        <>
          <span className="crumb-sep" aria-hidden="true" />
          <span className="crumb-here">{here}</span>
        </>
      )}
      <span className="spacer" />
      {tabs.length > 1 && (
        <nav className="place-tabs" aria-label={place?.label}>
          {tabs.map((t) => (
            <Link
              key={t.path}
              to={t.path}
              className={`place-tab${t.path === props.path ? " on" : ""}`}
              current={t.path === props.path}
            >
              {t.tab}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

function commandSections(me: Me): CommandSection[] {
  const entries = (within: string, routes: { path: string; tab: string }[]) =>
    routes.map((r) => ({ label: r.tab, to: r.path, within }));
  return [
    ...PLACES.map((p) => ({ value: p.label, items: entries(p.label, placeTabs(p.id, me)) })),
    ...settingsGroups(me).map((g) => ({
      value: `Settings: ${g.label}`,
      items: entries("Settings", g.routes),
    })),
    {
      value: "Help",
      items: [{ label: "Documentation", to: DOCS, within: "Help", external: true }],
    },
  ];
}

export function Frame(props: {
  me: Me;
  route: Route | undefined;
  path: string;
  children: ReactNode;
}) {
  const settings = props.route?.place === "settings";
  return (
    <div className="frame">
      <Rail me={props.me} place={props.route?.place} />
      <div className="panel">
        <PageBar me={props.me} route={props.route} path={props.path} />
        <div className={settings ? "panel-body with-nav" : "panel-body"}>
          {settings && <SettingsNav me={props.me} path={props.path} />}
          <main className="content">{props.children}</main>
        </div>
      </div>
      <CommandMenu sections={commandSections(props.me)} />
    </div>
  );
}
