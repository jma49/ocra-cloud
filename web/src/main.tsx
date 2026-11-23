import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SetupState } from "../../src/shared/index.js";
import { completeAgents } from "./agent-prefs.js";
import { ApiError, api, type Me, prefetch } from "./api.js";
import { cacheFor, clearCache } from "./cache.js";
import { Footer, TopBar } from "./chrome.js";
import { PrefsProvider } from "./prefs.js";
import { prepareWith, usePath } from "./router.js";
import { loadLikelyPages, matchRoute, prefetchRoute } from "./routes.js";
import { Frame } from "./shell.js";
import { rememberSignedIn, wasSignedIn } from "./signed-in.js";
import { SignIn } from "./signin.js";
import { reloadOnStaleBuild } from "./stale-build.js";
import { followTheme } from "./theme.js";
import { setPageTitle } from "./title.js";
import { ToastProvider } from "./toast.js";
import { ErrorBoundary, Loading, NotFound } from "./ui.js";
import "./styles.css";

const Privacy = lazy(() => import("./pages/Privacy.js").then((m) => ({ default: m.Privacy })));
const Setup = lazy(() => import("./setup/Setup.js").then((m) => ({ default: m.Setup })));

/** A self-hosted server nobody can sign in to yet opens on its settings page; elsewhere /api/setup is missing. */
function useSetupNeeded(signedOut: boolean): boolean | undefined {
  const [needed, setNeeded] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!signedOut) return;
    api<SetupState>("/setup").then(
      (s) => setNeeded(s.needed === true),
      () => setNeeded(false),
    );
  }, [signedOut]);
  return needed;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    // With /me, not after it, in a browser that was signed in: the first
    // page's reads are already on their way.
    if (wasSignedIn()) {
      const found = matchRoute(location.pathname);
      for (const load of found?.route.loads ?? []) load().catch(() => {});
      for (const read of found?.route.reads?.(found.params) ?? []) prefetch(read);
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
  const setupNeeded = useSetupNeeded(me === null);
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
  if (path === "/setup" || (me === null && setupNeeded)) {
    return (
      <>
        <TopBar me={me ?? null} />
        <main className="content solo">
          <Suspense fallback={<Loading what="the settings" />}>
            <Setup />
          </Suspense>
        </main>
        <Footer />
      </>
    );
  }
  if (me === undefined || (me === null && setupNeeded === undefined)) return <TopBar me={null} />;
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
followTheme();
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
