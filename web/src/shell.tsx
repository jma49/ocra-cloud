import {
  Bell,
  Book,
  Brain,
  ChartBar,
  Coins,
  Flag,
  Folder,
  GitPullRequest,
  History,
  Inbox,
  Key,
  type KubaiIconComponent,
  ListChecks,
  Puzzle,
  SettingsIcon,
  Sliders,
  Terminal,
  User,
} from "kubai-icons-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { Me } from "./api.js";
import { AccountMenu } from "./chrome.js";
import { CommandMenu, type CommandSection } from "./command-menu.js";
import { EyesMark } from "./eyes.js";
import { Link } from "./router.js";
import { type Place, placeHome, placeTabs, type Route, settingsGroups } from "./routes.js";
import { DOCS } from "./site.js";

// The signed-in frame: the icon rail of places on the ground, and the open
// page on a panel beside it, headed by where it is and its place's tabs.

const PLACES: { id: Place; label: string; icon: KubaiIconComponent }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "reviews", label: "Reviews", icon: GitPullRequest },
  { id: "findings", label: "Findings", icon: Flag },
  { id: "repositories", label: "Repositories", icon: Folder },
  { id: "insights", label: "Insights", icon: ChartBar },
];

const SETTINGS_ICONS: Record<string, KubaiIconComponent> = {
  "/agents": Brain,
  "/review-settings": Sliders,
  "/rules": ListChecks,
  "/plugins": Puzzle,
  "/defaults": History,
  "/keys": Key,
  "/budget": Coins,
  "/settings": User,
  "/notifications": Bell,
  "/sessions": Terminal,
};

function RailLink(props: { to: string; label: string; on: boolean; icon: KubaiIconComponent }) {
  const Icon = props.icon;
  return (
    <Link
      to={props.to}
      className={`rail-link${props.on ? " on" : ""}`}
      current={props.on}
      label={props.label}
    >
      <Icon size={20} variant={props.on ? "color" : "soft"} trigger="parent" />
    </Link>
  );
}

function Rail(props: { me: Me; place: Place | undefined }) {
  return (
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
      <a
        className="rail-link"
        href={DOCS}
        target="_blank"
        rel="noreferrer"
        aria-label="Documentation"
        title="Documentation"
      >
        <Book size={20} variant="soft" trigger="parent" />
      </a>
      <RailLink
        to={placeHome("settings")}
        label="Settings"
        on={props.place === "settings"}
        icon={SettingsIcon}
      />
      <AccountMenu me={props.me} compact />
    </nav>
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
            const Icon = SETTINGS_ICONS[r.path] ?? SettingsIcon;
            const on = r.path === props.path;
            return (
              <Link
                key={r.path}
                to={r.path}
                className={`settings-link${on ? " on" : ""}`}
                current={on}
              >
                <Icon size={16} variant={on ? "color" : "soft"} trigger="parent" />
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
