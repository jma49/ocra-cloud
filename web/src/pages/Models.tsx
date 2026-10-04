import { useEffect, useMemo, useState } from "react";
import { api, type Key, type ModelChains, type ProviderInfo } from "../api.js";
import { Link } from "../router.js";
import { PageHead, useLoad } from "../ui.js";

const TIERS = [
  { id: "standard", label: "Standard", hint: "Reviews the code. Most requests go here." },
  {
    id: "light",
    label: "Light",
    hint: "Helper work such as grouping files. A small, cheap model.",
  },
  { id: "top", label: "Top", hint: "Judges the findings. Your strongest model." },
] as const;
type Tier = (typeof TIERS)[number]["id"];
type Entry = { id: string; provider: string; model: string };

const split = (m: string): Entry => {
  const slash = m.indexOf("/");
  return { id: crypto.randomUUID(), provider: m.slice(5, slash), model: m.slice(slash + 1) };
};

export function Models() {
  const [providers] = useLoad(() => api<{ providers: ProviderInfo[] }>("/providers"));
  const [keys] = useLoad(() => api<{ keys: Key[] }>("/keys"));
  const [saved, , reload] = useLoad(() => api<{ models: ModelChains }>("/preferences/models"));
  const [draft, setDraft] = useState<Record<Tier, Entry[]>>({ top: [], standard: [], light: [] });
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!saved) return;
    setDraft({
      top: (saved.models.top ?? []).map(split),
      standard: (saved.models.standard ?? []).map(split),
      light: (saved.models.light ?? []).map(split),
    });
  }, [saved]);

  // Providers with a stored key and an OpenAI-compatible chat endpoint.
  const usable = useMemo(() => {
    const have = new Set((keys?.keys ?? []).map((k) => k.provider));
    return (providers?.providers ?? []).filter(
      (p) => have.has(p.name) && p.paths.some((x) => x.endsWith("/chat/completions")),
    );
  }, [providers, keys]);

  const save = async () => {
    setStatus("");
    const body = Object.fromEntries(
      TIERS.map((t) => [
        t.id,
        draft[t.id]
          .filter((e) => e.provider && e.model.trim())
          .map((e) => `ocra-${e.provider}/${e.model.trim()}`),
      ]),
    );
    try {
      await api("/preferences/models", { method: "PUT", body: JSON.stringify(body) });
      setStatus("Saved.");
      reload();
    } catch {
      setStatus("Could not save: check the model names.");
    }
  };

  if (keys && usable.length === 0) {
    return (
      <>
        <PageHead title="Default models" />
        <div className="card empty-hero">
          <h3>Add a provider key first</h3>
          <p>
            Default models run through your own keys. Add a key from a provider with an
            OpenAI-compatible endpoint.
          </p>
          <Link to="/keys" className="btn btn-primary">
            Add a key
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Default models"
        sub="Used by ocra review when you are signed in and the repository configures no models."
        actions={
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        }
      />
      {status && <p className={status === "Saved." ? "small" : "error"}>{status}</p>}
      {TIERS.map((t) => (
        <div className="card section" key={t.id} style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <h3>{t.label}</h3>
              <div className="subtle small">{t.hint} Later entries are fallbacks.</div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={draft[t.id].length >= 4}
              onClick={() =>
                setDraft({
                  ...draft,
                  [t.id]: [
                    ...draft[t.id],
                    { id: crypto.randomUUID(), provider: usable[0]?.name ?? "", model: "" },
                  ],
                })
              }
            >
              + Add model
            </button>
          </div>
          {draft[t.id].length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              Not set.
            </div>
          ) : (
            draft[t.id].map((e, i) => (
              <ModelRow
                key={e.id}
                entry={e}
                usable={usable}
                onChange={(next) =>
                  setDraft({ ...draft, [t.id]: draft[t.id].map((x, j) => (j === i ? next : x)) })
                }
                onRemove={() =>
                  setDraft({ ...draft, [t.id]: draft[t.id].filter((_, j) => j !== i) })
                }
              />
            ))
          )}
        </div>
      ))}
    </>
  );
}

function ModelRow(props: {
  entry: Entry;
  usable: ProviderInfo[];
  onChange: (e: Entry) => void;
  onRemove: () => void;
}) {
  const { entry } = props;
  const [models] = useLoad(
    () =>
      entry.provider
        ? api<{ models: string[] }>(`/keys/${entry.provider}/models`)
        : Promise.resolve({ models: [] }),
    [entry.provider],
  );
  const listId = `models-${entry.provider}`;
  return (
    <div className="list-row" style={{ flexWrap: "wrap" }}>
      <select
        className="input"
        aria-label="Provider"
        value={entry.provider}
        onChange={(e) => props.onChange({ ...entry, provider: e.target.value, model: "" })}
      >
        {props.usable.map((p) => (
          <option key={p.name} value={p.name}>
            {p.label}
          </option>
        ))}
      </select>
      <input
        className="input mono grow"
        aria-label="Model"
        list={listId}
        placeholder={
          models?.models.length ? `Choose from ${models.models.length} models or type` : "Model id"
        }
        value={entry.model}
        onChange={(e) => props.onChange({ ...entry, model: e.target.value })}
      />
      <datalist id={listId}>
        {(models?.models ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button type="button" className="btn btn-sm btn-danger" onClick={props.onRemove}>
        Remove
      </button>
    </div>
  );
}
