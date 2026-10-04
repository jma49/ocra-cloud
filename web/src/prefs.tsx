import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "./api.js";

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
};

type Ctx = {
  saved: Prefs | undefined;
  draft: Prefs | undefined;
  setDraft: (p: Prefs) => void;
  dirty: boolean;
  saving: boolean;
  error: string;
  save: () => Promise<void>;
  discard: () => void;
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

export function PrefsProvider(props: { children: ReactNode; clean?: (p: Prefs) => Prefs }) {
  const [saved, setSaved] = useState<Prefs | undefined>(undefined);
  const [draft, setDraft] = useState<Prefs | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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
        body: JSON.stringify(strip(props.clean ? props.clean(draft) : draft)),
      });
      setSaved(next);
      setDraft(next);
      toast("Settings saved");
    } catch {
      setError("Not saved: a value is out of range or a model name is incomplete.");
    } finally {
      setSaving(false);
    }
  }, [draft, props.clean, toast]);

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
    () => ({ saved, draft, setDraft, dirty, saving, error, save, discard, toast }),
    [saved, draft, dirty, saving, error, save, discard, toast],
  );
  return (
    <PrefsContext.Provider value={value}>
      {props.children}
      {dirty && (
        <section className="savebar" aria-label="Unsaved changes">
          <span>{error || "You have unsaved changes"}</span>
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
export function useSettings() {
  const { draft, setDraft } = usePrefs();
  const settings = draft?.settings ?? {};
  const set = <K extends keyof Settings>(key: K, value: Settings[K] | undefined) => {
    if (!draft) return;
    const next = { ...settings };
    const empty =
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0);
    if (empty) delete next[key];
    else next[key] = value;
    setDraft({ ...draft, settings: next });
  };
  return { settings, set };
}
