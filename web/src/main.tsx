import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { completeAgents } from "./agent-prefs.js";
import { ApiError, api, type Me } from "./api.js";
import { cacheFor, clearCache } from "./cache.js";
import { Footer, TopBar } from "./chrome.js";
import { PrefsProvider } from "./prefs.js";
import { prepareWith, usePath } from "./router.js";
import { loadLikelyPages, matchRoute, prefetchRoute } from "./routes.js";
import { Frame } from "./shell.js";
import { rememberSignedIn, wasSignedIn } from "./signed-in.js";
import { SignIn } from "./signin.js";
import { reloadOnStaleBuild } from "./stale-build.js";
import { setPageTitle } from "./title.js";
import { ToastProvider } from "./toast.js";
import { ErrorBoundary, Loading, NotFound } from "./ui.js";
import "./styles.css";

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
  useEffect(() => {
    if (!me) return;
    prepareWith((to, intent) => prefetchRoute(to, me, intent));
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1000));
    idle(() => loadLikelyPages(me));
  }, [me]);
  const found = matchRoute(path, me ?? undefined);
  useEffect(() => {
    setPageTitle(me ? found?.route.tab : undefined);
  }, [found?.route, me]);

  if (path === "/privacy") {
    return (
      <>
        <TopBar me={me ?? null} />
        <main className="content solo">
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
    <Frame me={me} route={found?.route} path={path}>
      <PrefsProvider clean={completeAgents} idle={!found?.route.prefs}>
        <ErrorBoundary key={path}>
          <Suspense fallback={<Loading what="the page" />}>
            {found ? found.route.page(me, found.params) : <NotFound />}
          </Suspense>
        </ErrorBoundary>
      </PrefsProvider>
    </Frame>
  );
}

reloadOnStaleBuild();
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
