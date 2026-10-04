import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { Activity } from "./pages/Activity.js";
import { Agents, completeAgents } from "./pages/Agents.js";
import { Defaults } from "./pages/Defaults.js";
import { Device } from "./pages/Device.js";
import { Keys } from "./pages/Keys.js";
import { Memory } from "./pages/Memory.js";
import { Overview } from "./pages/Overview.js";
import { Plugins } from "./pages/Plugins.js";
import { Privacy } from "./pages/Privacy.js";
import { ReviewDetail } from "./pages/ReviewDetail.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { Sessions } from "./pages/Sessions.js";
import { Settings } from "./pages/Settings.js";
import { PrefsProvider } from "./prefs.js";
import { Link, usePath } from "./router.js";
import { SignIn } from "./signin.js";
import { SmallSpider } from "./spider.js";
import { Icon, type icons } from "./ui.js";
import "./styles.css";

const DOCS = "https://ocra.majincheng.com";

type NavItem = { to: string; label: string; icon: keyof typeof icons };
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Console",
    items: [
      { to: "/", label: "Overview", icon: "home" },
      { to: "/activity", label: "Activity", icon: "activity" },
      { to: "/reviews", label: "Reviews", icon: "check" },
    ],
  },
  {
    label: "Configure",
    items: [
      { to: "/keys", label: "Provider keys", icon: "key" },
      { to: "/agents", label: "Agents", icon: "layers" },
      { to: "/review-settings", label: "Review settings", icon: "sliders" },
      { to: "/rules", label: "Rules", icon: "list" },
      { to: "/plugins", label: "Plugins", icon: "puzzle" },
      { to: "/memory", label: "Memory", icon: "check" },
      { to: "/defaults", label: "Defaults & history", icon: "file" },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/sessions", label: "CLI & sessions", icon: "terminal" },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

function TopBar(props: { me: Me | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <SmallSpider size={24} />
        ocra
        <span className="brand-tag">cloud · dev</span>
      </Link>
      <span className="spacer" />
      <a className="toplink hide-sm" href={DOCS} target="_blank" rel="noreferrer">
        Docs
      </a>
      <a
        className="toplink hide-sm"
        href="https://github.com/jma49/Open-CR-Agent"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
      {props.me && (
        <div ref={ref}>
          <button
            type="button"
            className="avatar-btn"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <img
              className="avatar"
              src={`https://avatars.githubusercontent.com/u/${props.me.githubId}?s=64`}
              alt=""
            />
            <span className="small">{props.me.login}</span>
          </button>
          {open && (
            <div className="menu" role="menu">
              <div className="menu-head">
                <div style={{ fontWeight: 500 }}>{props.me.login}</div>
                <div className="subtle small">Signed in with GitHub</div>
              </div>
              <Link to="/settings" className="menu-item">
                Settings
              </Link>
              <a className="menu-item" href={DOCS} target="_blank" rel="noreferrer">
                Documentation
              </a>
              <button type="button" className="menu-item" onClick={logout}>
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <a href="/privacy">Data policy</a>
      <a href={DOCS} target="_blank" rel="noreferrer">
        Docs
      </a>
      <a href="https://github.com/jma49/Open-CR-Agent" target="_blank" rel="noreferrer">
        GitHub
      </a>
    </footer>
  );
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    api<Me>("/me").then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    const page = NAV.find((n) => n.to === path)?.label;
    document.title = page && me ? `${page} · ocra Cloud` : "ocra Cloud";
  }, [path, me]);

  if (path === "/privacy") {
    return (
      <>
        <TopBar me={me ?? null} />
        <main className="content" style={{ maxWidth: 820, margin: "0 auto" }}>
          <Privacy />
        </main>
        <Footer />
      </>
    );
  }
  if (me === undefined) return <TopBar me={null} />;
  if (me === null)
    return (
      <>
        <TopBar me={null} />
        <SignIn next={path === "/" ? undefined : location.pathname + location.search} />
        <Footer />
      </>
    );
  const page =
    path === "/device" ? (
      <Device />
    ) : path === "/activity" ? (
      <Activity />
    ) : path.startsWith("/reviews/") ? (
      <ReviewDetail id={decodeURIComponent(path.slice("/reviews/".length))} />
    ) : path === "/memory" ? (
      <Memory />
    ) : path === "/reviews" ? (
      <Reviews />
    ) : path === "/agents" || path === "/models" ? (
      <Agents />
    ) : path === "/review-settings" ? (
      <ReviewSettings />
    ) : path === "/rules" ? (
      <Rules />
    ) : path === "/plugins" ? (
      <Plugins />
    ) : path === "/defaults" ? (
      <Defaults />
    ) : path === "/keys" ? (
      <Keys />
    ) : path === "/sessions" ? (
      <Sessions />
    ) : path === "/settings" ? (
      <Settings me={me} />
    ) : (
      <Overview login={me.login} />
    );
  return (
    <>
      <TopBar me={me} />
      <div className="shell">
        <nav className="sidebar" aria-label="Console">
          {NAV_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="side-label">{g.label}</div>
              {g.items.map((n) => (
                <Link key={n.to} to={n.to} className={`side-link${path === n.to ? " active" : ""}`}>
                  <Icon name={n.icon} />
                  {n.label}
                </Link>
              ))}
            </div>
          ))}
          <div className="side-label">Resources</div>
          <a className="side-link" href={DOCS} target="_blank" rel="noreferrer">
            <Icon name="book" />
            Documentation
          </a>
          <a className="side-link" href="/privacy">
            <Icon name="check" />
            Data policy
          </a>
        </nav>
        <main className="content">
          <PrefsProvider clean={completeAgents}>{page}</PrefsProvider>
        </main>
      </div>
    </>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
