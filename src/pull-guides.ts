import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Scoped } from "./db/scoped.js";
import { apiError } from "./http.js";
import type { CodePlatform } from "./platforms/platform.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type {
  PullDiffRange,
  PullHighlight,
  PullHighlightsView,
  PullTourStop,
  PullTourView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's tour and highlights at one head. Nothing writes them yet:
// a host that has a generator (Host.pullGuides) answers with what it makes,
// any other answers not_found with `available: false`, so the page can tell
// "not built" from "no such pull request".

export type PullGuideRequest = {
  data: Scoped;
  platform: CodePlatform;
  token: string;
  repo: string;
  number: number;
  head: string;
};

type Guide = { model: string | null };

/** Where a generator plugs in; null when it has none for the pull request at that head. */
export type PullGuides = {
  tour(request: PullGuideRequest): Promise<(Guide & { stops: PullTourStop[] }) | null>;
  highlights(request: PullGuideRequest): Promise<(Guide & { highlights: PullHighlight[] }) | null>;
};

export const pullGuidesRoute = new Hono<AppEnv>();

const guideQuery = z.object({ ...pullRef, head: sha });

const rangeDto = (r: PullDiffRange) =>
  ({ path: r.path, side: r.side, start: r.start, end: r.end }) satisfies PullDiffRange;
const stopDto = (s: PullTourStop) =>
  ({ title: s.title, text: s.text, ranges: s.ranges.map(rangeDto) }) satisfies PullTourStop;
const highlightDto = (h: PullHighlight) =>
  ({ range: rangeDto(h.range), reason: h.reason }) satisfies PullHighlight;

const unavailable = (c: Context<AppEnv>) => apiError(c, "not_found", { available: false });

async function requestOf(c: Context<AppEnv>) {
  const ref = guideQuery.safeParse(c.req.query());
  if (!ref.success) return { refusal: apiError(c, "not_found") } as const;
  const guides = c.var.pullGuides;
  if (!guides) return { refusal: unavailable(c) } as const;
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return { refusal: reached.refusal } as const;
  const { repo, number, head } = ref.data;
  const { platform, token } = reached;
  const request = { data: c.var.data, platform, token, repo, number, head };
  return { guides, request } as const;
}

const pullOf = (r: PullGuideRequest) => ({
  platform: r.platform.kind,
  repo: r.repo,
  number: r.number,
  head: r.head,
});

pullGuidesRoute.get("/tour", requireSession(["web"]), perMinute("platform"), async (c) => {
  const asked = await requestOf(c);
  if ("refusal" in asked) return asked.refusal;
  const tour = await asked.guides.tour(asked.request);
  if (!tour) return unavailable(c);
  return c.json({
    ...pullOf(asked.request),
    model: tour.model,
    stops: tour.stops.map(stopDto),
  } satisfies PullTourView);
});

pullGuidesRoute.get("/highlights", requireSession(["web"]), perMinute("platform"), async (c) => {
  const asked = await requestOf(c);
  if ("refusal" in asked) return asked.refusal;
  const found = await asked.guides.highlights(asked.request);
  if (!found) return unavailable(c);
  return c.json({
    ...pullOf(asked.request),
    model: found.model,
    highlights: found.highlights.map(highlightDto),
  } satisfies PullHighlightsView);
});
