import type { PullFilters, PullView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";

export type ViewDraft = { name: string; filters: PullFilters };

const PARAM = "section";

/** A link that offers the section to whoever opens it, with their own pulls. */
export function shareLink(view: ViewDraft): string {
  const json = new TextEncoder().encode(JSON.stringify({ name: view.name, filters: view.filters }));
  const code = btoa(String.fromCharCode(...json))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${location.origin}/pulls?${PARAM}=${code}`;
}

/** The section a shared link offers; null when there is none or it does not read. */
export function sharedView(search: string): ViewDraft | null {
  const code = new URLSearchParams(search).get(PARAM);
  if (!code) return null;
  try {
    const bytes = Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const view = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ViewDraft>;
    if (typeof view.name !== "string" || typeof view.filters !== "object" || !view.filters) {
      return null;
    }
    return { name: view.name, filters: view.filters };
  } catch {
    return null;
  }
}

export function forgetSharedView() {
  const url = new URL(location.href);
  url.searchParams.delete(PARAM);
  history.replaceState(null, "", url.pathname + url.search);
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** The account's own sections; each change shows at once and rolls back if refused. */
export function usePullViews() {
  const { data, change, reload } = useCached("/pull-views", () =>
    api<{ views: PullView[] }>("/pull-views"),
  );
  const views = data?.views ?? [];

  const attempt = async (undo: () => void, call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (e) {
      undo();
      throw e;
    } finally {
      reload();
    }
  };

  return {
    views,
    add: (draft: ViewDraft) =>
      attempt(
        change((d) => ({
          views: [
            ...d.views,
            { id: `new-${d.views.length}`, position: d.views.length, hidden: false, ...draft },
          ],
        })),
        () => api<PullView>("/pull-views", { method: "POST", ...json(draft) }),
      ),
    save: (id: string, draft: ViewDraft) =>
      attempt(
        change((d) => ({ views: d.views.map((v) => (v.id === id ? { ...v, ...draft } : v)) })),
        () => api(`/pull-views/${id}`, { method: "PUT", ...json(draft) }),
      ),
    remove: (id: string) =>
      attempt(
        change((d) => ({ views: d.views.filter((v) => v.id !== id) })),
        () => api(`/pull-views/${id}`, { method: "DELETE" }),
      ),
  };
}
