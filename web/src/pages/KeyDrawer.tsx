import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type KeyCheck, type ProviderInfo } from "../api.js";
import { ProviderLogo } from "../ui.js";

// Adding or replacing a key: a drawer that starts with the common providers,
// then takes the key and says what the provider made of it.

export const POPULAR = [
  "openrouter",
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "xai",
  "moonshot",
  "qwen",
];
const GROUPS: { id: ProviderInfo["group"]; label: string }[] = [
  { id: "Major", label: "Model makers" },
  { id: "China", label: "China" },
  { id: "Platforms", label: "Inference platforms" },
];

export function formats(p: ProviderInfo): string {
  return [
    p.paths.some((x) => x.includes("chat/completions") || x.includes("responses")) && "OpenAI",
    p.paths.some((x) => x.includes("messages")) && "Anthropic",
    p.paths.some((x) => x.includes("generateContent")) && "Gemini",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AddKeyDrawer(props: {
  providers: ProviderInfo[];
  configured: Set<string>;
  initial: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(props.initial);
  const [q, setQ] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyCheck | null>(null);
  const [error, setError] = useState("");
  const byName = new Map(props.providers.map((p) => [p.name, p]));
  const p = chosen ? byName.get(chosen) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!p) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api<{ check: KeyCheck }>(`/keys/${p.name}`, {
        method: "PUT",
        body: JSON.stringify({ key: value }),
      });
      setValue("");
      setResult(res.check);
      props.onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "bad_key"
          ? "That does not look like an API key."
          : "Could not save the key.",
      );
    } finally {
      setBusy(false);
    }
  };

  const matches = props.providers.filter((x) =>
    `${x.label} ${x.name} ${new URL(x.base).host}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <div className="scrim" onClick={props.onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Add a provider key">
        <div className="drawer-head">
          <h2>
            {p
              ? `${props.configured.has(p.name) ? "Replace" : "Add"} ${p.label} key`
              : "Add a provider key"}
          </h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!p ? (
          <div className="drawer-body">
            <input
              className="input"
              style={{ width: "100%", height: 38 }}
              placeholder={`Search ${props.providers.length} providers by name or domain`}
              aria-label="Search providers"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: the drawer opens to choose a provider
              autoFocus
            />
            {q.trim() === "" ? (
              <>
                <div className="group-label">Popular</div>
                <div className="tiles">
                  {POPULAR.map((n) => byName.get(n))
                    .filter((x): x is ProviderInfo => !!x)
                    .map((x) => (
                      <button
                        key={x.name}
                        type="button"
                        className="tile"
                        onClick={() => setChosen(x.name)}
                      >
                        <ProviderLogo label={x.label} size={30} />
                        <span>
                          <div className="t-name">{x.label}</div>
                          <div className="t-sub">
                            {props.configured.has(x.name) ? "Configured" : formats(x)}
                          </div>
                        </span>
                      </button>
                    ))}
                </div>
                {GROUPS.map((g) => (
                  <div key={g.id}>
                    <div className="group-label">{g.label}</div>
                    <PickList
                      items={props.providers.filter(
                        (x) => x.group === g.id && !POPULAR.includes(x.name),
                      )}
                      configured={props.configured}
                      onPick={setChosen}
                    />
                  </div>
                ))}
              </>
            ) : matches.length ? (
              <>
                <div className="group-label">{matches.length} found</div>
                <PickList items={matches} configured={props.configured} onPick={setChosen} />
              </>
            ) : (
              <div className="empty">No provider matches “{q}”.</div>
            )}
          </div>
        ) : (
          <form
            className="drawer-body"
            onSubmit={save}
            style={{ display: "flex", flexDirection: "column" }}
          >
            <div className="chosen">
              <ProviderLogo label={p.label} size={36} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.label}</div>
                <div className="subtle small mono">{new URL(p.base).host}</div>
              </div>
              {!props.initial && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setChosen(null);
                    setResult(null);
                  }}
                >
                  Change
                </button>
              )}
            </div>
            <div className="field">
              <label htmlFor="key-input">API key</label>
              <input
                id="key-input"
                className="input mono"
                style={{ height: 38 }}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the key"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the provider is chosen, the key comes next
                autoFocus
              />
              <span className="hint">
                {props.configured.has(p.name) ? "Saving replaces the current key. " : ""}
                We check it with a request that uses no tokens.
              </span>
            </div>
            <div className="field">
              <label htmlFor="key-endpoints">Endpoints you can call through ocra</label>
              <div id="key-endpoints" className="pick-list">
                {p.paths.map((path) => (
                  <div key={path} className="pick" style={{ cursor: "default" }}>
                    <span className="mono small">
                      {path.startsWith("^") ? "/v1beta/models/{model}:generateContent" : path}
                    </span>
                  </div>
                ))}
              </div>
              <span className="hint">Formats: {formats(p)}.</span>
            </div>
            {result && <CheckNote check={result} label={p.label} />}
            {error && <div className="note err">{error}</div>}
            <div style={{ flex: 1 }} />
            <div className="drawer-foot" style={{ margin: "20px -20px -20px" }}>
              <button type="button" className="btn" onClick={props.onClose}>
                {result ? "Done" : "Cancel"}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || value.trim().length < 8}
              >
                {busy ? "Checking…" : "Save and test"}
              </button>
            </div>
          </form>
        )}
      </aside>
    </>
  );
}

function PickList(props: {
  items: ProviderInfo[];
  configured: Set<string>;
  onPick: (name: string) => void;
}) {
  return (
    <div className="pick-list">
      {props.items.map((x) => (
        <button key={x.name} type="button" className="pick" onClick={() => props.onPick(x.name)}>
          <ProviderLogo label={x.label} size={24} />
          <span className="grow">{x.label}</span>
          {props.configured.has(x.name) ? (
            <span className="badge badge-ok">Configured</span>
          ) : (
            <span className="subtle small">{formats(x)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function CheckNote(props: { check: KeyCheck; label: string }) {
  const { status, httpStatus } = props.check;
  if (status === "ok")
    return (
      <div className="note ok">
        <span className="check">✓</span> Saved. {props.label} accepted the key.
      </div>
    );
  if (status === "invalid")
    return (
      <div className="note err">
        Saved, but {props.label} rejected the key (HTTP {httpStatus}). Check it was copied in full,
        then replace it.
      </div>
    );
  if (status === "error")
    return (
      <div className="note">
        {`Saved. ${props.label} did not answer the check${httpStatus ? ` (HTTP ${httpStatus})` : ""}; try Test later.`}
      </div>
    );
  return (
    <div className="note">
      Saved. {props.label} cannot check a key in advance; the first request will show whether it
      works.
    </div>
  );
}
