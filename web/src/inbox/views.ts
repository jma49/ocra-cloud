import type { PullFilters, PullView, PullViewsAnswer } from "../../../src/shared/index.js";
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

const DEFAULT_ID = "default:";

const inOrder = (views: PullView[]) => [...views].sort((a, b) => a.position - b.position);

/**
 * The inbox's sections: the account's own, or the server's defaults while it
 * has none. Each change shows at once and rolls back if refused; the first
 * change to the defaults keeps them as the account's own.
 */
export function usePullViews() {
  const { data, change, reload } = useCached("/pull-views", () =>
    api<PullViewsAnswer>("/pull-views"),
  );
  const kept = data?.views ?? [];
  const views: PullView[] =
    kept.length > 0
      ? inOrder(kept)
      : (data?.defaults ?? []).map((d, position) => ({
          id: `${DEFAULT_ID}${position}`,
          position,
          hidden: false,
          ...d,
        }));

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

  /** The account's own views, the defaults kept first when it has none. */
  const own = async (): Promise<PullView[]> => {
    if (kept.length > 0 || views.length === 0) return inOrder(kept);
    const answer = await api<{ views: PullView[] }>("/pull-views/defaults", { method: "POST" });
    change(() => ({ views: answer.views, defaults: [] }));
    return inOrder(answer.views);
  };
  /** A shown view among the account's own: a default is found by its name once kept. */
  const ownOf = (all: PullView[], view: PullView) =>
    all.find((v) => (view.id.startsWith(DEFAULT_ID) ? v.name === view.name : v.id === view.id));

  const update = async (view: PullView, next: Partial<PullView>) => {
    const target = ownOf(await own(), view);
    if (!target) return;
    const { name, filters, hidden } = { ...target, ...next };
    await attempt(
      change((d) => ({
        ...d,
        views: d.views.map((v) => (v.id === target.id ? { ...v, ...next } : v)),
      })),
      () => api(`/pull-views/${target.id}`, { method: "PUT", ...json({ name, filters, hidden }) }),
    );
  };

  return {
    ready: data !== undefined,
    views,
    add: async (draft: ViewDraft) => {
      const all = await own();
      await attempt(
        change((d) => ({
          ...d,
          views: [
            ...d.views,
            { id: `new-${all.length}`, position: all.length, hidden: false, ...draft },
          ],
        })),
        () => api<PullView>("/pull-views", { method: "POST", ...json(draft) }),
      );
    },
    save: (view: PullView, draft: ViewDraft) => update(view, draft),
    setHidden: (view: PullView, hidden: boolean) => update(view, { hidden }),
    remove: async (view: PullView) => {
      const target = ownOf(await own(), view);
      if (!target) return;
      await attempt(
        change((d) => ({ ...d, views: d.views.filter((v) => v.id !== target.id) })),
        () => api(`/pull-views/${target.id}`, { method: "DELETE" }),
      );
    },
    /** Trades places with the shown section before (-1) or after (1) it. */
    move: async (view: PullView, step: -1 | 1) => {
      const all = await own();
      const target = ownOf(all, view);
      const shown = all.filter((v) => !v.hidden);
      const other = target && shown[shown.indexOf(target) + step];
      if (!target || !other) return;
      const ids = all.map((v) => (v === target ? other.id : v === other ? target.id : v.id));
      await attempt(
        change((d) => ({
          ...d,
          views: d.views.map((v) => ({ ...v, position: ids.indexOf(v.id) })),
        })),
        () => api("/pull-views/order", { method: "PUT", ...json({ ids }) }),
      );
    },
  };
}
