import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { Activity } from "./pages/Activity.js";
import { Keys } from "./pages/Keys.js";
import { Overview } from "./pages/Overview.js";
import { Sessions } from "./pages/Sessions.js";
import { Settings } from "./pages/Settings.js";
import { Link, usePath } from "./router.js";
import { Icon, type icons } from "./ui.js";
import "./styles.css";

const DOCS = "https://ocra.majincheng.com";

const NAV: { to: string; label: string; icon: keyof typeof icons }[] = [
  { to: "/", label: "Overview", icon: "home" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/keys", label: "Provider keys", icon: "key" },
  { to: "/sessions", label: "CLI & sessions", icon: "terminal" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

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
        <span className="brand-mark">o</span>
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

function SignIn() {
  const points = [
    [
      "Your keys, encrypted.",
      "Bring a key from any of 45 providers; it is encrypted and never shown again.",
    ],
    [
      "Every call on record.",
      "See each model call made with your keys: model, tokens, status and time.",
    ],
    ["Your code stays yours.", "Prompts and answers pass through and are never stored or logged."],
  ];
  return (
    <div className="signin">
      <div className="signin-box">
        <h1>Code review agents, with your own keys</h1>
        <p className="lead">Sign in to manage provider keys and see what ocra does with them.</p>
        <a className="btn btn-primary btn-lg" href="/api/auth/github/login">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Continue with GitHub
        </a>
        <div className="signin-points">
          {points.map(([t, d]) => (
            <div key={t}>
              <span className="check">✓</span>
              <span>
                <b>{t}</b> {d}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
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

  if (me === undefined) return <TopBar me={null} />;
  if (me === null)
    return (
      <>
        <TopBar me={null} />
        <SignIn />
      </>
    );
  const page =
    path === "/activity" ? (
      <Activity />
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
          <div className="side-label">Console</div>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`side-link${path === n.to ? " active" : ""}`}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
          <div className="side-label">Resources</div>
          <a className="side-link" href={DOCS} target="_blank" rel="noreferrer">
            <Icon name="book" />
            Documentation
          </a>
        </nav>
        <main className="content">{page}</main>
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
