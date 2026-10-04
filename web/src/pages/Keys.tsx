import { type FormEvent, useMemo, useState } from "react";
import { ApiError, api, date, type Key, type ProviderInfo } from "../api.js";
import { PageHead, ProviderLogo, Seg, useLoad } from "../ui.js";

type Filter = "all" | "configured" | "Major" | "China" | "Platforms";

export function Keys() {
  const [providers] = useLoad(() => api<{ providers: ProviderInfo[] }>("/providers"));
  const [keys, , reload] = useLoad(() => api<{ keys: Key[] }>("/keys"));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const byProvider = useMemo(() => new Map((keys?.keys ?? []).map((k) => [k.provider, k])), [keys]);

  const list = (providers?.providers ?? [])
    .filter((p) => {
      if (filter === "configured") return byProvider.has(p.name);
      if (filter !== "all") return p.group === filter;
      return true;
    })
    .filter((p) => !q || `${p.label} ${p.name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(byProvider.has(b.name)) - Number(byProvider.has(a.name)));

  return (
    <>
      <PageHead
        title="Provider keys"
        sub="Bring your own key. ocra calls each provider with your key and you pay the provider directly."
      />
      <div className="card card-pad small muted" style={{ marginBottom: 16 }}>
        Keys are encrypted with a per-key data key wrapped by a master key held apart from the
        database, and are never shown again after saving. Set a spending limit at your provider.
      </div>
      <div className="card">
        <div className="card-head" style={{ flexWrap: "wrap" }}>
          <Seg
            value={filter}
            options={[
              { value: "all", label: "All" },
              { value: "configured", label: `Configured (${byProvider.size})` },
              { value: "Major", label: "Major" },
              { value: "China", label: "China" },
              { value: "Platforms", label: "Platforms" },
            ]}
            onChange={setFilter}
          />
          <input
            className="input"
            placeholder="Search providers"
            aria-label="Search providers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
        </div>
        {list.length === 0 && <div className="empty">No providers match.</div>}
        {list.map((p) => (
          <ProviderRow
            key={p.name}
            provider={p}
            stored={byProvider.get(p.name)}
            open={open === p.name}
            onToggle={() => setOpen(open === p.name ? null : p.name)}
            onSaved={() => {
              setOpen(null);
              reload();
            }}
          />
        ))}
      </div>
    </>
  );
}

function ProviderRow(props: {
  provider: ProviderInfo;
  stored: Key | undefined;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const { provider: p, stored } = props;
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/keys/${p.name}`, { method: "PUT", body: JSON.stringify({ key: value }) });
      setValue("");
      props.onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "bad_key"
          ? "That does not look like a key."
          : "Could not save.",
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    await api(`/keys/${p.name}`, { method: "DELETE" }).catch(() => setError("Could not delete."));
    setBusy(false);
    setConfirm(false);
    props.onSaved();
  };
  const formats = [
    p.paths.some((x) => x.includes("chat/completions") || x.includes("responses")) && "OpenAI",
    p.paths.some((x) => x.includes("messages")) && "Anthropic",
    p.paths.some((x) => x.includes("generateContent")) && "Gemini",
  ].filter(Boolean);

  return (
    <>
      <div className="list-row">
        <ProviderLogo label={p.label} />
        <div className="grow">
          <div style={{ fontWeight: 500 }}>{p.label}</div>
          <div className="subtle small">
            {formats.join(" · ")} format · <span className="mono">{new URL(p.base).host}</span>
          </div>
        </div>
        {stored ? (
          <>
            <span className="badge badge-ok">
              <span className="dot" />…{stored.last4}
            </span>
            <span className="subtle small hide-sm">added {date(stored.createdAt)}</span>
            {confirm ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-solid"
                  disabled={busy}
                  onClick={remove}
                >
                  Delete key
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-sm" onClick={props.onToggle}>
                  Replace
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setConfirm(true)}
                >
                  Delete
                </button>
              </>
            )}
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={props.onToggle}>
            {props.open ? "Cancel" : "Add key"}
          </button>
        )}
      </div>
      {props.open && (
        <form className="inline-form" onSubmit={save}>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${p.label} API key`}
            aria-label={`${p.label} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the row was just opened to type a key
            autoFocus
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || value.trim().length < 8}
          >
            {stored ? "Replace key" : "Save key"}
          </button>
          {error && <span className="error">{error}</span>}
        </form>
      )}
    </>
  );
}
