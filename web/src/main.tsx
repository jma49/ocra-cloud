import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { Footer, TopBar } from "./chrome.js";
import { completeAgents } from "./pages/Agents.js";
import { Privacy } from "./pages/Privacy.js";
import { PrefsProvider } from "./prefs.js";
import { Link, usePath } from "./router.js";
import { matchRoute, NAV_GROUPS } from "./routes.js";
import { SignIn } from "./signin.js";
import { DOCS } from "./site.js";
import { ToastProvider } from "./toast.js";
import { ErrorBoundary, Icon, NotFound } from "./ui.js";
import "./styles.css";

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    api<Me>("/me").then(setMe, () => setMe(null));
  }, []);
  const found = matchRoute(path);
  useEffect(() => {
    const page = found?.route.nav?.label;
    document.title = page && me ? `${page} · ocra Cloud` : "ocra Cloud";
  }, [found?.route, me]);

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
  return (
    <>
      <TopBar me={me} />
      <div className="shell">
        <nav className="sidebar" aria-label="Console">
          {NAV_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="side-label">{g.label}</div>
              {g.routes.map((r) => (
                <Link
                  key={r.path}
                  to={r.path}
                  className={`side-link${path === r.path ? " active" : ""}`}
                >
                  <Icon name={r.nav.icon} />
                  {r.nav.label}
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
          <PrefsProvider clean={completeAgents} idle={!found?.route.prefs}>
            <ErrorBoundary key={path}>
              {found ? found.route.page(me, found.params) : <NotFound />}
            </ErrorBoundary>
          </PrefsProvider>
        </main>
      </div>
    </>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>,
  );
}
