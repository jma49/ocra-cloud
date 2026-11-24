import { type FormEvent, useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ApiError, api, type KeyCheck, type ProviderInfo } from "../api.js";
import { Drawer } from "../drawer.js";
import { DoneGlyph } from "../glyphs.js";
import { ProviderLogo } from "../provider-logo.js";
import { ActionError, EmptyNote } from "../ui.js";

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
  { id: "Company", label: "Your company" },
  { id: "Major", label: "Model makers" },
  { id: "China", label: "China" },
  { id: "Platforms", label: "Inference platforms" },
];

function formats(p: ProviderInfo): string {
  return [
    p.paths.some((x) => x.includes("chat/completions") || x.includes("responses")) && "OpenAI",
    p.paths.some((x) => x.includes("messages")) && "Anthropic",
    p.paths.some((x) => x.includes("generateContent")) && "Gemini",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Where a provider's calls go: what tells two endpoints of one provider apart. */
export const hostOf = (p: ProviderInfo) => new URL(p.base).host;

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
  const [error, setError] = useState<unknown>(null);
  const byName = new Map(props.providers.map((p) => [p.name, p]));
  const p = chosen ? byName.get(chosen) : undefined;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!p) return;
    setBusy(true);
    setError(null);
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
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const matches = props.providers.filter((x) =>
    `${x.label} ${x.name} ${new URL(x.base).host}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <Drawer
      title="Add a provider key"
      heading={
        p
          ? `${props.configured.has(p.name) ? "Replace" : "Add"} ${p.label} key`
          : "Add a provider key"
      }
      onClose={props.onClose}
      {...(p
        ? {
            onSubmit: save,
            foot: (
              <>
                <Button type="button" variant="outline" onClick={props.onClose}>
                  {result ? "Done" : "Cancel"}
                </Button>
                <Button type="submit" disabled={busy || value.trim().length < 8}>
                  {busy ? "Checking…" : "Save and test"}
                </Button>
              </>
            ),
          }
        : {})}
    >
      {!p ? (
        <>
          <input
            className="input provider-search"
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
                      <ProviderLogo name={x.name} label={x.label} size={30} />
                      <span>
                        <div className="t-name">{x.label}</div>
                        <div className="t-sub">
                          {props.configured.has(x.name) ? "Configured" : hostOf(x)}
                        </div>
                      </span>
                    </button>
                  ))}
              </div>
              {GROUPS.map((g) => {
                const items = props.providers.filter(
                  (x) => x.group === g.id && !POPULAR.includes(x.name),
                );
                return items.length === 0 ? null : (
                  <div key={g.id}>
                    <div className="group-label">{g.label}</div>
                    <PickList items={items} configured={props.configured} onPick={setChosen} />
                  </div>
                );
              })}
            </>
          ) : matches.length ? (
            <>
              <div className="group-label">{matches.length} found</div>
              <PickList items={matches} configured={props.configured} onPick={setChosen} />
            </>
          ) : (
            <EmptyNote>No provider matches “{q}”</EmptyNote>
          )}
        </>
      ) : (
        <>
          <div className="chosen">
            <ProviderLogo name={p.name} label={p.label} size={36} />
            <div className="grow">
              <div className="semibold">{p.label}</div>
              <div className="subtle small">{hostOf(p)}</div>
            </div>
            {!props.initial && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setChosen(null);
                  setResult(null);
                }}
              >
                Change
              </Button>
            )}
          </div>
          <div className="field">
            <label htmlFor="key-input">API key</label>
            <input
              id="key-input"
              className="input mono key-input"
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
                <div key={path} className="pick static">
                  <span className="mono small">
                    {path.startsWith("^") ? "/v1beta/models/{model}:generateContent" : path}
                  </span>
                </div>
              ))}
            </div>
            <span className="hint">
              API {formats(p).includes(",") ? "formats" : "format"}: {formats(p)}
            </span>
          </div>
          {result && <CheckNote check={result} label={p.label} />}
          {error !== null &&
            (error instanceof ApiError && error.code === "invalid_body" ? (
              <div className="note err">That does not look like an API key.</div>
            ) : (
              <ActionError what="save the key" error={error} />
            ))}
        </>
      )}
    </Drawer>
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
          <ProviderLogo name={x.name} label={x.label} size={24} />
          <span className="grow">{x.label}</span>
          {props.configured.has(x.name) && <Status tone="ok">Configured</Status>}
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
        <DoneGlyph /> Saved. {props.label} accepted the key.
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
