import { useMemo, useState } from "react";
import { formatModelId, parseModelId } from "../../../src/shared/index.js";
import { loadKeys } from "../account-keys.js";
import { api } from "../api.js";
import { ago } from "../format.js";
import { type Prefs, type Settings, usePrefs } from "../prefs.js";
import { useToast } from "../toast.js";
import { PageHead, useLoad } from "../ui.js";

// Your defaults as files, an import from a repository's file, and every
// saved version (ADR-0027). The web cannot see a repository's own file, so
// this is what a repository with none would run with, not a merge.

const DATA_KEYS = [
  "concurrency",
  "taskTimeoutMinutes",
  "runTimeoutMinutes",
  "maxCostUsd",
  "maxTasks",
  "verify",
  "judge",
  "sampling",
  "include",
  "exclude",
] as const;
const DROPPED = ["providers", "extends", "plugins", "$schema", "pluginSettings", "github"];

function asConfig(p: Prefs): Record<string, unknown> {
  const s = p.settings;
  const out: Record<string, unknown> = {
    $schema:
      "https://raw.githubusercontent.com/jma49/Open-CR-Agent/main/docs/schema/config.v1.json",
  };
  if (p.runtime) out.runtime = p.runtime;
  if (Object.keys(p.models).length) out.models = p.models;
  if (p.agents.effort && Object.keys(p.agents.effort).length) out.effort = p.agents.effort;
  if (p.agents.reviewers && Object.keys(p.agents.reviewers).length)
    out.reviewers = p.agents.reviewers;
  if (p.agents.roles && Object.keys(p.agents.roles).length) out.roles = p.agents.roles;
  for (const k of DATA_KEYS) if (s[k] !== undefined) out[k] = s[k];
  if (s.plugins?.length) out.plugins = s.plugins;
  if (s.pluginSettings && Object.keys(s.pluginSettings).length)
    out.pluginSettings = s.pluginSettings;
  return out;
}

type Imported = { next: Prefs; notes: string[] };

/** Data keys only; models become gateway models where the account holds the key. */
function importConfig(text: string, current: Prefs, keyed: Set<string>): Imported | string {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(text) as Record<string, unknown>;
    if (typeof file !== "object" || file === null || Array.isArray(file))
      return "That is not a JSON object.";
  } catch {
    return "That is not valid JSON.";
  }
  const notes: string[] = [];
  for (const k of DROPPED)
    if (k in file && k !== "$schema")
      notes.push(`${k} is not taken from a file (it can move code or keys, or is set per machine)`);
  const mapModel = (m: string): string | undefined => {
    if (parseModelId(m)) return m;
    const slash = m.indexOf("/");
    const provider = m.slice(0, slash);
    if (slash > 0 && keyed.has(provider)) return formatModelId(provider, m.slice(slash + 1));
    notes.push(`${m} dropped: no ${provider || "matching"} key in your account`);
    return undefined;
  };
  const chain = (v: unknown) => {
    const list = (Array.isArray(v) ? v : v ? [v] : []).filter(
      (m): m is string => typeof m === "string",
    );
    const mapped = list.map(mapModel).filter((m): m is string => !!m);
    return mapped.length ? mapped : undefined;
  };
  const models: Prefs["models"] = {};
  for (const [t, v] of Object.entries((file.models ?? {}) as Record<string, unknown>)) {
    const c = chain(v);
    if (c) models[t as keyof Prefs["models"]] = c;
  }
  const reviewers: NonNullable<Prefs["agents"]["reviewers"]> = {};
  for (const [id, r] of Object.entries(
    (file.reviewers ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const entry = { ...r } as Record<string, unknown>;
    if ("models" in entry) {
      const c = chain(entry.models);
      if (c) entry.models = c;
      else delete entry.models;
    }
    delete entry.minTier;
    reviewers[id] = entry;
  }
  const settings: Settings = { ...current.settings };
  for (const k of DATA_KEYS)
    if (file[k] !== undefined) (settings as Record<string, unknown>)[k] = file[k];
  return {
    next: {
      ...current,
      ...(file.runtime === "direct" || file.runtime === "opencode"
        ? { runtime: file.runtime }
        : {}),
      models: { ...current.models, ...models },
      agents: {
        ...current.agents,
        ...(file.effort ? { effort: file.effort as NonNullable<Prefs["agents"]["effort"]> } : {}),
        reviewers: { ...current.agents.reviewers, ...reviewers },
        ...(file.roles ? { roles: file.roles as NonNullable<Prefs["agents"]["roles"]> } : {}),
      },
      settings,
    },
    notes,
  };
}

export function Defaults() {
  const { draft, setDraft } = usePrefs();
  const toast = useToast();
  const { data: keys } = useLoad(loadKeys);
  const { data: versions, reload: reloadVersions } = useLoad(() =>
    api<{ versions: { id: string; createdAt: string; changed: string[] }[] }>(
      "/preferences/versions",
    ),
  );
  const [paste, setPaste] = useState("");
  const [result, setResult] = useState<{ notes: string[]; error?: string } | null>(null);
  const keyed = useMemo(() => new Set((keys?.keys ?? []).map((k) => k.provider)), [keys]);
  if (!draft) return <PageHead title="Defaults & history" />;

  const config = JSON.stringify(asConfig(draft), null, 2);
  const rules = draft.settings.rules?.length
    ? JSON.stringify({ rules: draft.settings.rules }, null, 2)
    : null;
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    toast("Copied");
  };
  const restore = async (id: string) => {
    try {
      await api(`/preferences/versions/${id}/restore`, { method: "POST" });
      location.reload();
    } catch {
      toast("That version no longer fits today's rules");
    }
  };

  return (
    <>
      <PageHead
        title="Defaults & history"
        sub="Your settings as files to commit, an import from an existing file, and every saved version."
      />
      <div className="card">
        <div className="card-head">
          <h3>.ocra/config.json</h3>
          <button type="button" className="btn btn-sm" onClick={() => copy(config)}>
            Copy
          </button>
        </div>
        <pre className="codeblock">{config}</pre>
      </div>
      {rules && (
        <div className="section card">
          <div className="card-head">
            <h3>.ocra/rules.json</h3>
            <button type="button" className="btn btn-sm" onClick={() => copy(rules)}>
              Copy
            </button>
          </div>
          <pre className="codeblock">{rules}</pre>
        </div>
      )}
      <p className="subtle small footnote">
        This is what a repository with no configuration runs with. A repository's own file wins
        where it sets the same thing; run <span className="mono">ocra review --plan</span> there to
        see the result.
      </p>

      <div className="section card">
        <div className="card-head">
          <h3>Import from a file</h3>
        </div>
        <div className="card-pad import-form">
          <textarea
            className="input mono"
            rows={6}
            aria-label="Configuration to import"
            placeholder="Paste a .ocra/config.json"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="row-gap">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!paste.trim()}
              onClick={() => {
                const r = importConfig(paste, draft, keyed);
                if (typeof r === "string") setResult({ notes: [], error: r });
                else {
                  setDraft(r.next);
                  setResult({ notes: r.notes });
                  setPaste("");
                }
              }}
            >
              Import into draft
            </button>
            <span className="subtle small self-center">Review the other pages, then save.</span>
          </div>
          {result?.error && <p className="error">{result.error}</p>}
          {result && !result.error && (
            <div className="note ok import-note">
              Imported into the draft.
              {result.notes.length > 0 && (
                <ul>
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="section card">
        <div className="card-head">
          <h3>History</h3>
          <button type="button" className="btn btn-sm" onClick={reloadVersions}>
            Refresh
          </button>
        </div>
        {versions && versions.versions.length === 0 && (
          <div className="empty">No saved versions yet.</div>
        )}
        {(versions?.versions ?? []).map((v, i) => (
          <div className="list-row" key={v.id}>
            <div className="grow">
              <div className="strong">
                {ago(v.createdAt)} {i === 0 && <span className="badge badge-ok">current</span>}
              </div>
              <div className="subtle small">Changed: {v.changed.join(", ")}</div>
            </div>
            {i > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => restore(v.id)}>
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
