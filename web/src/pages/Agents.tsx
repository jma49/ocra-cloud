import KeyRound from "lucide-react/icons/key-round";
import Plus from "lucide-react/icons/plus";
import X from "lucide-react/icons/x";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  type AgentRole,
  BUILT_IN_REVIEWERS,
  chatPath,
  effortLevels,
  formatModelId,
  parseModelId,
  ROLES,
} from "../../../src/shared/index.js";
import { loadKeys } from "../account-keys.js";
import { api, type ProviderInfo } from "../api.js";
import { type AgentPrefs, type Effort, type Prefs, type Tier, usePrefs } from "../prefs.js";
import { Link } from "../router.js";
import { StackTable } from "../stack-table.js";
import { EmptyState, PageHead, Seg, useLoad, useProviders } from "../ui.js";

// The runtime, the tier defaults and each agent's model and reasoning effort
// (ADR-0025). The CLI layers these under a repository's own configuration.

type Chain = string[];
type ModelInfo = { id: string; efforts: Effort[] };

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Reviews the code" },
  { id: "light", label: "Light", hint: "Docs, AGENTS.md and helper work" },
  { id: "top", label: "Top", hint: "The judge" },
];

// A row's model; the editor writes only ocra-<provider>/<model> names.
const split = (m: string) => parseModelId(m) ?? { provider: "", model: m };

/**
 * The models of each provider with a key, asked for once per provider: each
 * request reaches the provider's own API with the account's key.
 */
function useModelInfo(providers: string[]) {
  const [info, setInfo] = useState<Record<string, ModelInfo[]>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const p of providers) {
      if (asked.current.has(p)) continue;
      asked.current.add(p);
      api<{ models: ModelInfo[] }>(`/keys/${p}/models`).then(
        (r) => setInfo((cur) => ({ ...cur, [p]: r.models })),
        () => setInfo((cur) => ({ ...cur, [p]: [] })),
      );
    }
  }, [providers]);
  return info;
}

export function Agents() {
  const providers = useProviders();
  const { data: keys } = useLoad(loadKeys);
  const { draft, setDraft } = usePrefs();

  const usable = useMemo(() => {
    const have = new Set((keys?.keys ?? []).map((k) => k.provider));
    return (providers ?? []).filter((p) => have.has(p.name) && chatPath(p.paths) !== undefined);
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
        <PageHead title="Agents & models" />
        <div className="card">
          <EmptyState
            icon={KeyRound}
            title="Add a provider key first"
            action={<Button render={<Link to="/keys" />}>Add a key</Button>}
          >
            Agents run on your own keys. Add a key from a provider the gateway can hold a
            conversation with.
          </EmptyState>
        </div>
      </>
    );
  }
  if (!draft) return <PageHead title="Agents & models" />;

  // Every write starts from the latest draft, never this render's copy, so
  // two writes before a render cannot drop one (the W1 bug class).
  const set = (change: (prev: Prefs) => Prefs) => setDraft(change);
  const setAgents = (change: (prev: AgentPrefs) => AgentPrefs) =>
    set((prev) => ({ ...prev, agents: change(prev.agents) }));
  const tierEffort = (t: Tier) => draft.agents.effort?.[t];
  const needsDirect = draft.runtime !== "direct" ? messagesOnly(draft, usable) : [];
  return (
    <>
      <PageHead
        title="Agents & models"
        sub="Defaults for ocra review when you are signed in. A repository's .ocra/config.json wins where it sets the same thing."
      />

      <div className="card card-pad">
        <div className="card-row">
          <div>
            <div className="semibold">Runtime</div>
            <div className="subtle small">
              Direct calls the models itself and applies reasoning effort; OpenCode runs each agent
              in OpenCode (effort not applied yet).
            </div>
          </div>
          <Seg
            label="Runtime"
            value={draft.runtime ?? "default"}
            options={[
              { value: "default", label: "Repository default" },
              { value: "direct", label: "Direct" },
              { value: "opencode", label: "OpenCode" },
            ]}
            onChange={(v) =>
              set((prev) => ({
                ...prev,
                runtime: v === "default" ? null : (v as "direct" | "opencode"),
              }))
            }
          />
        </div>
        {needsDirect.length > 0 && (
          <p className="note small center mb-0" role="status">
            <span className="grow">
              {needsDirect.join(", ")} {needsDirect.length === 1 ? "speaks" : "speak"} only the
              Messages protocol, which the Direct runtime handles and OpenCode does not.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set((prev) => ({ ...prev, runtime: "direct" }))}
            >
              Use Direct
            </Button>
          </p>
        )}
      </div>

      <div className="section card">
        <div className="card-head">
          <h3>Tier defaults</h3>
          <span className="subtle small">
            Every agent uses its tier unless set below. Later models are fallbacks.
          </span>
        </div>
        {TIERS.map((t) => (
          <div className="list-row row-top" key={t.id}>
            <div className="tier-label">
              <div className="strong">{t.label}</div>
              <div className="subtle small">{t.hint}</div>
            </div>
            <div className="grow">
              <ChainEditor
                chain={draft.models[t.id] ?? []}
                usable={usable}
                onChange={(chain) =>
                  set((prev) => ({ ...prev, models: { ...prev.models, [t.id]: chain } }))
                }
              />
            </div>
            <div className="tier-effort">
              <EffortSelect
                value={tierEffort(t.id)}
                levels={effortsOf(draft.models[t.id]?.[0])}
                onChange={(e) =>
                  setAgents((prev) => ({ ...prev, effort: { ...prev.effort, [t.id]: e } }))
                }
              />
            </div>
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
        <StackTable>
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
                ...BUILT_IN_REVIEWERS.map((r) => ({ ...r, role: false })),
                ...ROLES.map((r) => ({ ...r, role: true })),
              ].map((a) => {
                const own = a.role
                  ? draft.agents.roles?.[a.id as AgentRole]
                  : draft.agents.reviewers?.[a.id];
                // An undefined field is removed: the agent inherits it again.
                const update = (patch: {
                  enabled?: boolean | undefined;
                  models?: Chain | undefined;
                  effort?: Effort | undefined;
                }) =>
                  setAgents((prev) => {
                    const mine = a.role ? prev.roles?.[a.id as AgentRole] : prev.reviewers?.[a.id];
                    const merged = { ...mine, ...patch };
                    for (const k of Object.keys(merged) as (keyof typeof merged)[])
                      if (merged[k] === undefined) delete merged[k];
                    const next = merged as NonNullable<typeof mine>;
                    return a.role
                      ? { ...prev, roles: { ...prev.roles, [a.id]: next } }
                      : { ...prev, reviewers: { ...prev.reviewers, [a.id]: next } };
                  });
                const model = own?.models?.[0] ?? draft.models[a.tier]?.[0];
                const enabled = a.role
                  ? true
                  : (own as { enabled?: boolean } | undefined)?.enabled !== false;
                return (
                  <tr key={a.id} className={enabled ? undefined : "agent-off"}>
                    <td className="text">
                      <div className="mono strong">{a.id}</div>
                      <div className="subtle small">
                        {a.hint} · {a.tier}
                      </div>
                    </td>
                    <td>
                      {a.role ? (
                        <span className="subtle small">always</span>
                      ) : (
                        <Switch
                          aria-label={`${a.id} on`}
                          checked={enabled}
                          onCheckedChange={() => update({ enabled: enabled ? false : undefined })}
                        />
                      )}
                    </td>
                    <td className="chain-cell">
                      {own?.models ? (
                        <ChainEditor
                          chain={own.models}
                          usable={usable}
                          onChange={(c) => update({ models: c.length ? c : undefined })}
                        />
                      ) : (
                        <span className="small">
                          <span className="subtle">
                            {draft.models[a.tier]?.[0] ?? `${a.tier} tier (repository)`}
                          </span>{" "}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              update({
                                models: [
                                  draft.models[a.tier]?.[0] ?? formatModelId(usable[0]?.name ?? ""),
                                ],
                              })
                            }
                          >
                            Override
                          </Button>
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
        </StackTable>
      </div>
      <ModelLists usable={usable} info={info} />
      <p className="subtle small footnote">
        Plugin reviewers can be set in the repository's configuration. Effort levels shown are the
        ones the model is known to take; a level a provider refuses is dropped for that run with a
        warning, never failing the review.
      </p>
    </>
  );
}

/** The chosen providers that only the Direct runtime can call, by label. */
function messagesOnly(p: Prefs, usable: ProviderInfo[]): string[] {
  const chains = [
    ...Object.values(p.models),
    ...Object.values(p.agents.reviewers ?? {}).map((r) => r?.models),
    ...Object.values(p.agents.roles ?? {}).map((r) => r?.models),
  ];
  const chosen = new Set(chains.flatMap((c) => c ?? []).map((m) => split(m).provider));
  return usable
    .filter((u) => chosen.has(u.name) && chatPath(u.paths)?.wire === "anthropic")
    .map((u) => u.label);
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
  const withModels = <T extends { models?: Chain }>(r: T | undefined): T => {
    const { models, ...rest } = r ?? ({} as T);
    const done = keep(models);
    return (done ? { ...rest, models: done } : rest) as T;
  };
  const reviewers = Object.fromEntries(
    Object.entries(p.agents.reviewers ?? {}).map(([id, r]) => [id, withModels(r)]),
  );
  const roles = Object.fromEntries(
    Object.entries(p.agents.roles ?? {}).map(([id, r]) => [id, withModels(r)]),
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
    return <span className="subtle small">No effort levels</span>;
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

/** The datalist a model field of this provider suggests from (ModelLists). */
const modelListId = (provider: string) => `models-${provider}`;

/**
 * One list of model ids per usable provider, for every row to share: a list
 * per row repeated ids and up to 2,000 options a row. Memoized, so typing in
 * a row does not render them again.
 */
const ModelLists = memo(function ModelLists(props: {
  usable: ProviderInfo[];
  info: Record<string, ModelInfo[]>;
}) {
  return (
    <>
      {props.usable.map((p) => (
        <datalist key={p.name} id={modelListId(p.name)}>
          {(props.info[p.name] ?? []).map((x) => (
            <option key={x.id} value={x.id} />
          ))}
        </datalist>
      ))}
    </>
  );
});

function ChainEditor(props: {
  chain: Chain;
  usable: ProviderInfo[];
  onChange: (chain: Chain) => void;
}) {
  const rows = props.chain.length ? props.chain : [];
  const setAt = (i: number, value: string) =>
    props.onChange(rows.map((m, j) => (j === i ? value : m)));
  return (
    <div className="chain">
      {rows.map((m, i) => {
        const { provider, model } = split(m);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is a position in the fallback chain; keying by the model id would remount it on every keystroke
          <div key={`${i}-${provider}`} className="chain-row">
            <select
              className="input"
              aria-label="Provider"
              value={provider}
              onChange={(e) => setAt(i, formatModelId(e.target.value))}
            >
              {props.usable.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              className="input mono chain-model"
              aria-label="Model"
              list={modelListId(provider)}
              placeholder="Model id"
              value={model}
              onChange={(e) => setAt(i, formatModelId(provider, e.target.value))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={i === 0 ? "Remove model" : "Remove fallback"}
              onClick={() => props.onChange(rows.filter((_, j) => j !== i))}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= 4}
          onClick={() => props.onChange([...rows, formatModelId(props.usable[0]?.name ?? "")])}
        >
          <Plus aria-hidden="true" />
          {rows.length ? "Fallback" : "Model"}
        </Button>
      </div>
    </div>
  );
}
