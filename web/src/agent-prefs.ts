import type { Prefs, Tier } from "./prefs.js";

// Kept apart from the Agents page: every page's save bar cleans with it,
// and the page's code loads only when it opens.

type Chain = string[];

export const TIER_IDS: readonly Tier[] = ["standard", "light", "top"];

// Drops models whose id is not filled in yet, so a half-edited row is not sent.
export function completeAgents(p: Prefs): Prefs {
  const keep = (c: Chain | undefined) => {
    const done = (c ?? []).filter((m) => !m.endsWith("/"));
    return done.length ? done : undefined;
  };
  const models = Object.fromEntries(
    TIER_IDS.map((t) => [t, keep(p.models[t])]).filter(([, c]) => c),
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
