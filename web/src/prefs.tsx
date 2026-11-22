import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type {
  AgentPrefs,
  Effort,
  ModelChains,
  ReviewSettings,
  Rule,
  Runtime,
  Tier,
} from "../../src/shared/index.js";
import { ApiError, api, why } from "./api.js";
import { useToast } from "./toast.js";

// The account's preferences, shared by the configuration pages: one saved
// copy, one draft, a save bar when they differ, and a toast after saving.
// They load when a configuration page first shows (idle until then), and
// the draft stays while the person visits other pages.

export type { AgentPrefs, Effort, Rule, Tier };
export type Settings = ReviewSettings;
export type Prefs = {
  runtime: Runtime | null;
  models: ModelChains;
  agents: AgentPrefs;
  settings: Settings;
  updatedAt?: string | null;
  // The saved version this copy is; a save says which one it started from.
  version?: string | null;
};

type Ctx = {
  saved: Prefs | undefined;
  draft: Prefs | undefined;
  // A value, or an update from the latest draft (two updates in one event
  // must not overwrite each other).
  setDraft: (p: Prefs | ((prev: Prefs) => Prefs)) => void;
  dirty: boolean;
  saving: boolean;
  error: string;
  save: () => Promise<void>;
  discard: () => void;
  // Set when a save was refused because the settings changed elsewhere.
  stale: boolean;
  reload: () => Promise<void>;
  // Counts Discard and Reload: a field holding text that never reached the
  // draft (such as "abc" in a number field) shows the saved value again.
  resets: number;
};

const PrefsContext = createContext<Ctx | null>(null);

/**
 * Whether two drafts hold the same values: key order does not matter, and a
 * key set to undefined is the same as no key (neither is sent). Array order
 * does matter (a model chain is tried in order).
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const defined = (o: object) =>
    Object.entries(o).filter(([, v]) => v !== undefined) as [string, unknown][];
  const ea = defined(a);
  const eb = new Map(defined(b));
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && same(v, eb.get(k)));
}
const strip = (p: Prefs) => ({
  runtime: p.runtime,
  models: p.models,
  agents: p.agents,
  settings: p.settings,
});

/** Why a save failed: the server's own refusal, else what went wrong getting there. */
function saveError(e: unknown): string {
  if (e instanceof ApiError && e.code === "invalid_body")
    return "Not saved: a value is out of range or a model name is incomplete.";
  return `Not saved: ${why(e)}.`;
}

/** Rules with no text are drafts: the page says they are not saved, so they are not sent. */
function dropEmptyRules(p: Prefs): Prefs {
  const rules = p.settings.rules?.filter((r) => r.rule.trim() !== "");
  if (rules === undefined || rules.length === p.settings.rules?.length) return p;
  const { rules: _, ...rest } = p.settings;
  return { ...p, settings: rules.length > 0 ? { ...rest, rules } : rest };
}

export function PrefsProvider(props: {
  children: ReactNode;
  clean?: (p: Prefs) => Prefs;
  /** No configuration page has shown yet: nothing to load. */
  idle?: boolean;
}) {
  const [saved, setSaved] = useState<Prefs | undefined>(undefined);
  const [draft, setDraft] = useState<Prefs | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [resets, setResets] = useState(0);
  const toast = useToast();
  // Latched: once a configuration page has shown, the preferences stay loaded.
  const [wanted, setWanted] = useState(!props.idle);
  useEffect(() => {
    if (!props.idle) setWanted(true);
  }, [props.idle]);

  useEffect(() => {
    if (!wanted) return;
    api<Prefs>("/preferences").then(
      (p) => {
        setSaved(p);
        setDraft(p);
      },
      () => setError("Could not load your settings."),
    );
  }, [wanted]);

  // Before the preferences load there is no draft to update.
  const update = useCallback((p: Prefs | ((prev: Prefs) => Prefs)) => {
    setDraft((prev) => (prev === undefined ? prev : typeof p === "function" ? p(prev) : p));
  }, []);

  const dirty = !!saved && !!draft && !same(strip(saved), strip(draft));

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const next = await api<Prefs>("/preferences", {
        method: "PUT",
        body: JSON.stringify({
          ...strip(dropEmptyRules(props.clean ? props.clean(draft) : draft)),
          baseVersion: saved?.version ?? null,
        }),
      });
      setSaved(next);
      setDraft(next);
      toast("Settings saved");
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") setStale(true);
      else setError(saveError(e));
    } finally {
      setSaving(false);
    }
  }, [draft, saved, props.clean, toast]);

  // Loads the newest settings in place of the draft. The page stays, so no
  // "leave site?" prompt: the draft is dropped by making it the saved copy.
  const reload = useCallback(async () => {
    setSaving(true);
    try {
      const p = await api<Prefs>("/preferences");
      setSaved(p);
      setDraft(p);
      setStale(false);
      setError("");
      setResets((n) => n + 1);
      toast("Loaded the latest settings");
    } catch {
      setError("Could not load your settings.");
    } finally {
      setSaving(false);
    }
  }, [toast]);

  const discard = useCallback(() => {
    setDraft(saved);
    setError("");
    setResets((n) => n + 1);
  }, [saved]);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const value = useMemo(
    () => ({
      saved,
      draft,
      setDraft: update,
      dirty,
      saving,
      error,
      save,
      discard,
      stale,
      reload,
      resets,
    }),
    [saved, draft, update, dirty, saving, error, save, discard, stale, reload, resets],
  );
  return (
    <PrefsContext.Provider value={value}>
      {props.children}
      {dirty && stale && (
        <section className="savebar" aria-label="Unsaved changes" role="alert">
          <span>
            Not saved: these settings were changed in another tab or window. Reload to see the
            latest; your changes here will be dropped.
          </span>
          <span className="row-gap">
            <Button type="button" size="sm" onClick={reload} disabled={saving}>
              {saving ? "Loading…" : "Reload"}
            </Button>
          </span>
        </section>
      )}
      {dirty && !stale && (
        <section className="savebar" aria-label="Unsaved changes">
          <span role={error ? "alert" : undefined}>{error || "You have unsaved changes"}</span>
          <span className="row-gap">
            <Button type="button" variant="outline" size="sm" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </span>
        </section>
      )}
    </PrefsContext.Provider>
  );
}

/** How many times the draft was reset; 0 outside a PrefsProvider. */
export function useResets(): number {
  return useContext(PrefsContext)?.resets ?? 0;
}

export function usePrefs(): Ctx {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs outside PrefsProvider");
  return ctx;
}

/** Unset: undefined, an empty list or an empty object. */
const isEmpty = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

/** Updates the draft's settings from the latest draft; an empty value removes the key. */
export function useSettings() {
  const { draft, setDraft } = usePrefs();
  const settings = draft?.settings ?? {};
  const setMany = (changes: Partial<Settings>) => {
    setDraft((prev) => {
      const next: Settings = { ...prev.settings };
      for (const [key, value] of Object.entries(changes) as [keyof Settings, unknown][]) {
        if (isEmpty(value)) delete next[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      return { ...prev, settings: next };
    });
  };
  const set = <K extends keyof Settings>(key: K, value: Settings[K] | undefined) =>
    setMany({ [key]: value } as Partial<Settings>);
  return { settings, set, setMany };
}
