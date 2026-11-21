import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api, type Me } from "./api.js";
import { cacheFor, clearCache } from "./cache.js";
import { Footer, TopBar } from "./chrome.js";
import { completeAgents } from "./pages/Agents.js";
import { PrefsProvider } from "./prefs.js";
import { Link, usePath } from "./router.js";
import { matchRoute, NAV_GROUPS } from "./routes.js";
import { rememberSignedIn, wasSignedIn } from "./signed-in.js";
import { SignIn } from "./signin.js";
import { DOCS } from "./site.js";
import { setPageTitle } from "./title.js";
import { ToastProvider } from "./toast.js";
import { ErrorBoundary, Icon, Loading, NotFound } from "./ui.js";
import "./styles.css";

const NAV_PATHS = NAV_GROUPS.flatMap((g) => g.routes.map((r) => r.path));

// The printed head of the sheet, as the manual heads its pages: where this
// page is and, for a page in the sidebar, which page of the console it is.
function SheetHead(props: { path: string; route?: string | undefined }) {
  const n = props.route === undefined ? -1 : NAV_PATHS.indexOf(props.route);
  return (
    <div className="sheet-head" aria-hidden="true">
      <span>
        {location.host}
        {props.path}
      </span>
      {n >= 0 && (
        <span>
          page {n + 1} of {NAV_PATHS.length}
        </span>
      )}
    </div>
  );
}

const Privacy = lazy(() => import("./pages/Privacy.js").then((m) => ({ default: m.Privacy })));

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    // With /me, not after it, in a browser that was signed in: the first
    // page's reads are already on their way.
    if (wasSignedIn()) {
      for (const load of matchRoute(location.pathname)?.route.loads ?? []) load().catch(() => {});
    }
    api<Me>("/me").then(
      (m) => {
        rememberSignedIn(true);
        cacheFor(m.login).then(() => setMe(m));
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          rememberSignedIn(false);
          void clearCache();
        }
        setMe(null);
      },
    );
  }, []);
  const found = matchRoute(path);
  useEffect(() => {
    setPageTitle(me ? found?.route.nav?.label : undefined);
  }, [found?.route, me]);

  if (path === "/privacy") {
    return (
      <>
        <TopBar me={me ?? null} />
        <main className="content">
          <SheetHead path={path} />
          <Suspense fallback={<Loading what="the data policy" />}>
            <Privacy />
          </Suspense>
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
          <SheetHead path={path} route={found?.route.path} />
          <PrefsProvider clean={completeAgents} idle={!found?.route.prefs}>
            <ErrorBoundary key={path}>
              <Suspense fallback={<Loading what="the page" />}>
                {found ? found.route.page(me, found.params) : <NotFound />}
              </Suspense>
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
