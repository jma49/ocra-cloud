import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError, api, why } from "./api.js";

// The account's preferences, shared by the configuration pages: one saved
// copy, one draft, a save bar when they differ, and a toast after saving.

export type Effort = "none" | "minimal" | "low" | "medium" | "high";
export type Tier = "top" | "standard" | "light";
export type Rule = { path: string | string[]; rule: string };
export type Settings = {
  ultra?: boolean;
  concurrency?: number;
  taskTimeoutMinutes?: number;
  runTimeoutMinutes?: number;
  maxCostUsd?: number;
  maxTasks?: number;
  verify?: boolean;
  judge?: boolean;
  sampling?: { temperature?: number; seed?: number };
  include?: string[];
  exclude?: string[];
  github?: { requestChanges?: boolean };
  rules?: Rule[];
  plugins?: string[];
  pluginSettings?: Record<string, unknown>;
};
export type AgentPrefs = {
  effort?: Partial<Record<Tier, Effort>>;
  reviewers?: Record<string, { enabled?: boolean; models?: string[]; effort?: Effort }>;
  roles?: Partial<Record<"verifier" | "judge" | "helper", { models?: string[]; effort?: Effort }>>;
};
export type Prefs = {
  runtime: "direct" | "opencode" | null;
  models: Partial<Record<Tier, string[]>>;
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
  toast: (message: string) => void;
};

const PrefsContext = createContext<Ctx | null>(null);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const strip = (p: Prefs) => ({
  runtime: p.runtime,
  models: p.models,
  agents: p.agents,
  settings: p.settings,
});

/** Why a save failed: the server's own refusal, else what went wrong getting there. */
export function saveError(e: unknown): string {
  if (e instanceof ApiError && e.code === "bad_preferences")
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

export function PrefsProvider(props: { children: ReactNode; clean?: (p: Prefs) => Prefs }) {
  const [saved, setSaved] = useState<Prefs | undefined>(undefined);
  const [draft, setDraft] = useState<Prefs | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api<Prefs>("/preferences").then(
      (p) => {
        setSaved(p);
        setDraft(p);
      },
      () => setError("Could not load your settings."),
    );
  }, []);

  // Before the preferences load there is no draft to update.
  const update = useCallback((p: Prefs | ((prev: Prefs) => Prefs)) => {
    setDraft((prev) => (prev === undefined ? prev : typeof p === "function" ? p(prev) : p));
  }, []);

  const toast = useCallback((m: string) => {
    setMessage(m);
    setTimeout(() => setMessage(""), 2600);
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
      toast,
    }),
    [saved, draft, update, dirty, saving, error, save, discard, stale, reload, toast],
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
          <span style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={reload}
              disabled={saving}
            >
              {saving ? "Loading…" : "Reload"}
            </button>
          </span>
        </section>
      )}
      {dirty && !stale && (
        <section className="savebar" aria-label="Unsaved changes">
          <span role={error ? "alert" : undefined}>{error || "You have unsaved changes"}</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={discard} disabled={saving}>
              Discard
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </span>
        </section>
      )}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </PrefsContext.Provider>
  );
}

export function usePrefs(): Ctx {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs outside PrefsProvider");
  return ctx;
}

/** Updates one part of the draft's settings; an empty value removes the key. */
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
