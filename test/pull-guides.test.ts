import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { PullGuideRequest, PullGuides } from "../src/pull-guides.js";
import type { PullHighlightsView, PullTourView } from "../src/shared/index.js";
import { ORIGIN, request, resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's tour and highlights: not built yet, so the API answers
// not_found with `available: false` unless the host plugs in a generator.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const QUERY = `platform=github&repo=octo/api&number=7&head=${HEAD}`;
const RANGE = { path: "src/a.ts", side: "new", start: 3, end: 9 } as const;

function withGuides(guides: PullGuides, cookie: string) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    pullGuides: guides,
  });
  return async (path: string) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(request(path, { headers: { cookie, origin: ORIGIN } }), env, ctx);
    const body = await res.json();
    await waitOnExecutionContext(ctx);
    return { status: res.status, body };
  };
}

describe("a pull request's tour and highlights", () => {
  it("are not available while no generator is plugged in", async () => {
    githubFake();
    const a = await signInWithGithub();
    for (const view of ["tour", "highlights"]) {
      const res = await a.send(`/api/pulls/${view}?${QUERY}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", available: false });
    }
  });

  it("refuses a query without the head it is for", async () => {
    githubFake();
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/tour?platform=github&repo=octo/api&number=7");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answer what a plugged-in generator makes for the reached pull request, projected", async () => {
    githubFake();
    const a = await signInWithGithub();
    const asked: PullGuideRequest[] = [];
    const send = withGuides(
      {
        tour: async (r) => {
          asked.push(r);
          const stop = { title: "Entry", text: "Starts here.", ranges: [{ ...RANGE, extra: 1 }] };
          return { model: "ocra-openai/gpt", stops: [stop], secret: "x" };
        },
        highlights: async () => ({
          model: null,
          highlights: [{ range: RANGE, reason: "Changes the schema." }],
        }),
      },
      a.cookie,
    );

    const tour = await send(`/api/pulls/tour?${QUERY}`);
    expect(tour.status).toBe(200);
    expect(tour.body).toEqual({
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: HEAD,
      model: "ocra-openai/gpt",
      stops: [{ title: "Entry", text: "Starts here.", ranges: [RANGE] }],
    } satisfies PullTourView);
    expect(asked.map((r) => [r.platform.kind, r.token, r.repo, r.number, r.head])).toEqual([
      ["github", "ghu_first", "octo/api", 7, HEAD],
    ]);

    const highlights = await send(`/api/pulls/highlights?${QUERY}`);
    expect((highlights.body as PullHighlightsView).highlights).toEqual([
      { range: RANGE, reason: "Changes the schema." },
    ]);
  });

  it("are not available when the generator has none for that head", async () => {
    githubFake();
    const a = await signInWithGithub();
    const send = withGuides({ tour: async () => null, highlights: async () => null }, a.cookie);
    expect(await send(`/api/pulls/highlights?${QUERY}`)).toEqual({
      status: 404,
      body: { error: "not_found", available: false },
    });
  });

  it("ask no generator for a platform the account has not connected", async () => {
    githubFake();
    const a = await signInWithGithub();
    let asked = 0;
    const send = withGuides(
      {
        tour: async () => {
          asked++;
          return null;
        },
        highlights: async () => null,
      },
      a.cookie,
    );
    const res = await send(`/api/pulls/tour?${QUERY.replace("github", "gitlab")}`);
    expect(res.status).not.toBe(200);
    expect(asked).toBe(0);
  });
});
