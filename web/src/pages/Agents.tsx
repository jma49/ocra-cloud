import { useEffect, useMemo, useState } from "react";
import { effortLevels } from "../../../src/capabilities.js";
import { api, type Key, type ProviderInfo } from "../api.js";
import { type AgentPrefs, type Effort, type Prefs, type Tier, usePrefs } from "../prefs.js";
import { Link } from "../router.js";
import { PageHead, Seg, useLoad } from "../ui.js";

// The runtime, the tier defaults and each agent's model and reasoning effort
// (ADR-0025). The CLI layers these under a repository's own configuration.

type Chain = string[];
type Role = "verifier" | "judge" | "helper";
type ModelInfo = { id: string; efforts: Effort[] };

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Reviews the code" },
  { id: "light", label: "Light", hint: "Docs, AGENTS.md and helper work" },
  { id: "top", label: "Top", hint: "The judge" },
];
const REVIEWERS: { id: string; tier: Tier; hint: string }[] = [
  { id: "correctness", tier: "standard", hint: "Bugs and broken logic" },
  { id: "security", tier: "standard", hint: "Vulnerabilities and unsafe patterns" },
  { id: "performance", tier: "standard", hint: "Slow paths and waste" },
  { id: "docs", tier: "light", hint: "Docs that no longer match the code" },
  { id: "agents-md", tier: "light", hint: "The repository's AGENTS.md rules" },
];
const ROLES: { id: Role; tier: Tier; hint: string }[] = [
  { id: "verifier", tier: "standard", hint: "Checks each finding against the code" },
  { id: "judge", tier: "top", hint: "Deduplicates and calibrates severity" },
  { id: "helper", tier: "light", hint: "Groups files and relocates quotes" },
];

const split = (m: string) => {
  const slash = m.indexOf("/");
  return { provider: m.slice(5, slash), model: m.slice(slash + 1) };
};

/** The models of each provider with a key, loaded once per provider. */
function useModelInfo(providers: string[]) {
  const [info, setInfo] = useState<Record<string, ModelInfo[]>>({});
  useEffect(() => {
    for (const p of providers) {
      if (info[p]) continue;
      api<{ models: ModelInfo[] }>(`/keys/${p}/models`).then(
        (r) => setInfo((cur) => ({ ...cur, [p]: r.models })),
        () => setInfo((cur) => ({ ...cur, [p]: [] })),
      );
    }
  }, [providers, info]);
  return info;
}

export function Agents() {
  const [providers] = useLoad(() => api<{ providers: ProviderInfo[] }>("/providers"));
  const [keys] = useLoad(() => api<{ keys: Key[] }>("/keys"));
  const { draft, setDraft } = usePrefs();

  const usable = useMemo(() => {
    const have = new Set((keys?.keys ?? []).map((k) => k.provider));
    return (providers?.providers ?? []).filter(
      (p) => have.has(p.name) && p.paths.some((x) => x.endsWith("/chat/completions")),
    );
  }, [providers, keys]);
  const names = useMemo(() => usable.map((p) => p.name), [usable]);
  const info = useModelInfo(names);

  const effortsOf = (model: string | undefined): Effort[] => {
    if (!model) return [];
    const { provider, model: id } = split(model);
    // The provider's own list (with OpenRouter's live data) first, then the shared table.
    return info[provider]?.find((m) => m.id === id)?.efforts ?? effortLevels(id);
  };

  if (keys && usable.length === 0) {
    return (
      <>
        <PageHead title="Agents" />
        <div className="card empty-hero">
          <h3>Add a provider key first</h3>
          <p>
            Agents run on your own keys. Add a key from a provider with an OpenAI-compatible
            endpoint.
          </p>
          <Link to="/keys" className="btn btn-primary">
            Add a key
          </Link>
        </div>
      </>
    );
  }
  if (!draft) return <PageHead title="Agents" />;

  const set = (next: Prefs) => setDraft(next);
  const setAgents = (agents: AgentPrefs) => set({ ...draft, agents });
  const tierEffort = (t: Tier) => draft.agents.effort?.[t];
  return (
    <>
      <PageHead
        title="Agents"
        sub="Defaults for ocra review when you are signed in. A repository's .ocra/config.json wins where it sets the same thing."
      />

      <div className="card card-pad">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Runtime</div>
            <div className="subtle small">
              Direct calls the models itself and applies reasoning effort; OpenCode runs each agent
              in OpenCode (effort not applied yet).
            </div>
          </div>
          <Seg
            value={draft.runtime ?? "default"}
            options={[
              { value: "default", label: "Repository default" },
              { value: "direct", label: "Direct" },
              { value: "opencode", label: "OpenCode" },
            ]}
            onChange={(v) =>
              set({ ...draft, runtime: v === "default" ? null : (v as "direct" | "opencode") })
            }
          />
        </div>
      </div>

      <div className="section card">
        <div className="card-head">
          <h3>Tier defaults</h3>
          <span className="subtle small">
            Every agent uses its tier unless set below. Later models are fallbacks.
          </span>
        </div>
        {TIERS.map((t) => (
          <div
            className="list-row"
            key={t.id}
            style={{ alignItems: "flex-start", flexWrap: "wrap" }}
          >
            <div style={{ width: 150 }}>
              <div style={{ fontWeight: 500 }}>{t.label}</div>
              <div className="subtle small">{t.hint}</div>
            </div>
            <div className="grow">
              <ChainEditor
                chain={draft.models[t.id] ?? []}
                usable={usable}
                info={info}
                onChange={(chain) => set({ ...draft, models: { ...draft.models, [t.id]: chain } })}
              />
            </div>
            <EffortSelect
              value={tierEffort(t.id)}
              levels={effortsOf(draft.models[t.id]?.[0])}
              onChange={(e) =>
                setAgents({ ...draft.agents, effort: { ...draft.agents.effort, [t.id]: e } })
              }
            />
          </div>
        ))}
      </div>

      <div className="section card">
        <div className="card-head">
          <h3>Agents</h3>
          <span className="subtle small">
            The verifier and judge never inherit a reviewer's model.
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>On</th>
                <th>Model</th>
                <th>Effort</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...REVIEWERS.map((r) => ({ ...r, role: false })),
                ...ROLES.map((r) => ({ ...r, role: true })),
              ].map((a) => {
                const own = a.role
                  ? draft.agents.roles?.[a.id as Role]
                  : draft.agents.reviewers?.[a.id];
                const update = (patch: { enabled?: boolean; models?: Chain; effort?: Effort }) => {
                  const next = { ...own, ...patch };
                  for (const k of Object.keys(next) as (keyof typeof next)[])
                    if (next[k] === undefined) delete next[k];
                  if (a.role)
                    setAgents({ ...draft.agents, roles: { ...draft.agents.roles, [a.id]: next } });
                  else
                    setAgents({
                      ...draft.agents,
                      reviewers: { ...draft.agents.reviewers, [a.id]: next },
                    });
                };
                const model = own?.models?.[0] ?? draft.models[a.tier]?.[0];
                const enabled = a.role
                  ? true
                  : (own as { enabled?: boolean } | undefined)?.enabled !== false;
                return (
                  <tr key={a.id} style={{ opacity: enabled ? 1 : 0.5 }}>
                    <td>
                      <div className="mono" style={{ fontWeight: 500 }}>
                        {a.id}
                      </div>
                      <div className="subtle small">
                        {a.hint} · {a.tier}
                      </div>
                    </td>
                    <td>
                      {a.role ? (
                        <span className="subtle small">always</span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`${a.id} on`}
                          checked={enabled}
                          onChange={(e) =>
                            update({ enabled: e.target.checked ? undefined : false })
                          }
                        />
                      )}
                    </td>
                    <td style={{ minWidth: 320 }}>
                      {own?.models ? (
                        <ChainEditor
                          chain={own.models}
                          usable={usable}
                          info={info}
                          onChange={(c) => update({ models: c.length ? c : undefined })}
                        />
                      ) : (
                        <span className="small">
                          <span className="subtle">
                            {draft.models[a.tier]?.[0] ?? `${a.tier} tier (repository)`}
                          </span>{" "}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              update({
                                models: [
                                  draft.models[a.tier]?.[0] ?? `ocra-${usable[0]?.name ?? ""}/`,
                                ],
                              })
                            }
                          >
                            Override
                          </button>
                        </span>
                      )}
                    </td>
                    <td>
                      <EffortSelect
                        value={own?.effort}
                        inherit={tierEffort(a.tier)}
                        levels={effortsOf(model)}
                        onChange={(e) => update({ effort: e })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="subtle small" style={{ marginTop: 12 }}>
        Plugin reviewers can be set in the repository's configuration. Effort levels shown are the
        ones the model is known to take; a level a provider refuses is dropped for that run with a
        warning, never failing the review.
      </p>
    </>
  );
}

// Drops models whose id is not filled in yet, so a half-edited row is not sent.
export function completeAgents(p: Prefs): Prefs {
  const keep = (c: Chain | undefined) => {
    const done = (c ?? []).filter((m) => !m.endsWith("/"));
    return done.length ? done : undefined;
  };
  const models = Object.fromEntries(
    TIERS.map((t) => [t.id, keep(p.models[t.id])]).filter(([, c]) => c),
  );
  const reviewers = Object.fromEntries(
    Object.entries(p.agents.reviewers ?? {}).map(([id, r]) => [
      id,
      { ...r, models: keep(r.models) },
    ]),
  );
  const roles = Object.fromEntries(
    Object.entries(p.agents.roles ?? {}).map(([id, r]) => [id, { ...r, models: keep(r?.models) }]),
  );
  return { ...p, models, agents: { ...p.agents, reviewers, roles } };
}

function EffortSelect(props: {
  value: Effort | undefined;
  inherit?: Effort | undefined;
  levels: Effort[];
  onChange: (e: Effort | undefined) => void;
}) {
  const levels =
    props.value && !props.levels.includes(props.value)
      ? [...props.levels, props.value]
      : props.levels;
  if (levels.length === 0) {
    return (
      <span className="subtle small" title="This model has no known effort levels">
        —
      </span>
    );
  }
  return (
    <select
      className="input"
      aria-label="Reasoning effort"
      value={props.value ?? ""}
      onChange={(e) => props.onChange((e.target.value || undefined) as Effort | undefined)}
    >
      <option value="">{props.inherit ? `Tier (${props.inherit})` : "Default"}</option>
      {levels.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

function ChainEditor(props: {
  chain: Chain;
  usable: ProviderInfo[];
  info: Record<string, ModelInfo[]>;
  onChange: (chain: Chain) => void;
}) {
  const rows = props.chain.length ? props.chain : [];
  const setAt = (i: number, value: string) =>
    props.onChange(rows.map((m, j) => (j === i ? value : m)));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((m, i) => {
        const { provider, model } = split(m);
        const listId = `chain-${provider}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is a position in the fallback chain; keying by the model id would remount it on every keystroke
          <div key={`${i}-${provider}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select
              className="input"
              aria-label="Provider"
              value={provider}
              onChange={(e) => setAt(i, `ocra-${e.target.value}/`)}
            >
              {props.usable.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              className="input mono"
              style={{ flex: 1, minWidth: 180 }}
              aria-label="Model"
              list={listId}
              placeholder="Model id"
              value={model}
              onChange={(e) => setAt(i, `ocra-${provider}/${e.target.value}`)}
            />
            <datalist id={listId}>
              {(props.info[provider] ?? []).map((x) => (
                <option key={x.id} value={x.id} />
              ))}
            </datalist>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => props.onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={rows.length >= 4}
          onClick={() => props.onChange([...rows, `ocra-${props.usable[0]?.name ?? ""}/`])}
        >
          + {rows.length ? "Fallback" : "Model"}
        </button>
      </div>
    </div>
  );
}
