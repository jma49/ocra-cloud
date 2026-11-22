import { viewDto, viewsOf } from "./pull-views.js";
import {
  DEFAULT_PULL_VIEWS,
  matchesPullFilters,
  type PullItem,
  type PullSection,
  type PullView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

/** The account's visible views, or the defaults while it has none, each holding the listed pulls it matches. */
export async function sectionsOf(
  data: AppEnv["Variables"]["data"],
  platforms: readonly { host: string; pulls: readonly PullItem[] }[],
  now: number,
): Promise<PullSection[]> {
  const stored = await viewsOf(data);
  const views: PullView[] =
    stored.length > 0
      ? stored.filter((v) => !v.hidden).map(viewDto)
      : DEFAULT_PULL_VIEWS.map((d, position) => ({
          id: `default:${position}`,
          ...d,
          position,
          hidden: false,
        }));
  const pulls = platforms.flatMap(({ host, pulls }) => pulls.map((p) => ({ ...p, host })));
  return views.map((view) => ({
    view,
    pulls: pulls
      .filter((p) => matchesPullFilters(p, view.filters, now))
      .map((p) => ({ host: p.host, id: p.id })),
  }));
}
