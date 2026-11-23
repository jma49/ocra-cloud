import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, forgetPrefetched, prefetch } from "./api.js";
import { lazyPage } from "./lazy-page.js";
import { Link, navigate, prepareWith } from "./router.js";
import { prefetchRoute } from "./routes.js";

// Reads started ahead of the page (on a hover, a press or with the
// navigation) are answered once to the page that makes them, and never
// stand in for a write or for a read made long after.

const me = {
  login: "ada",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web" as const,
  since: "2026-10-01T00:00:00Z",
  codeGraphs: "keep" as const,
  autoReview: true,
  platforms: ["github" as const],
};

let asked: string[];
beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${String(input).replace(/^\/api/, "")}`);
      if (String(input).includes("gone"))
        return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ n: asked.length });
    }),
  );
});
afterEach(() => {
  forgetPrefetched();
  prepareWith(() => {});
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prefetch", () => {
  it("answers the page's read with the one started ahead, whatever order its query has", async () => {
    prefetch("/pulls/files?platform=github&repo=a%2Fb&number=1");
    const answer = await api("/pulls/files?number=1&repo=a%2Fb&platform=github");
    expect(answer).toEqual({ n: 1 });
    expect(asked).toEqual(["GET /pulls/files?platform=github&repo=a%2Fb&number=1"]);
  });

  it("answers it once: the next read asks the server again", async () => {
    prefetch("/reviews");
    await api("/reviews");
    await api("/reviews");
    expect(asked).toEqual(["GET /reviews", "GET /reviews"]);
  });

  it("never answers a write, and never a read made after it went stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    prefetch("/notes");
    await api("/notes", { method: "POST", body: "{}" });
    vi.setSystemTime(Date.now() + 11_000);
    await api("/notes");
    expect(asked).toEqual(["GET /notes", "POST /notes", "GET /notes"]);
  });

  it("hands the page the refusal too, as its own read would have", async () => {
    prefetch("/gone");
    await expect(api("/gone")).rejects.toBeInstanceOf(ApiError);
    expect(asked).toEqual(["GET /gone"]);
  });
});

describe("prefetchRoute", () => {
  const pull = "/pull/github/a%2Fb/7";

  it("starts only a pull request's files on a hover, each of its reads on an open", () => {
    prefetchRoute(pull, me, "hover");
    expect(asked).toEqual(["GET /pulls/files?platform=github&repo=a%2Fb&number=7"]);
    asked = [];
    prefetchRoute(pull, me, "open");
    expect(asked).toHaveLength(10);
    expect(asked).not.toContain("GET /pulls/files?platform=github&repo=a%2Fb&number=7");
    expect(asked).toContain("GET /pulls/readiness?platform=github&repo=a%2Fb&number=7");
  });

  it("starts nothing for an unknown path or another site", () => {
    prefetchRoute("/no-such-page", me, "open");
    prefetchRoute("https://example.com/pull/github/a%2Fb/7", me, "open");
    expect(asked).toEqual([]);
  });
});

describe("intent", () => {
  it("gets a page ready as the pointer rests on its link, not as it passes", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    prepareWith(ready);
    render(<Link to="/reviews">Reviews</Link>);
    const link = screen.getByText("Reviews");
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    fireEvent.pointerLeave(link, { pointerType: "mouse" });
    vi.advanceTimersByTime(100);
    expect(ready).not.toHaveBeenCalled();
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    vi.advanceTimersByTime(100);
    expect(ready).toHaveBeenCalledWith("/reviews", "hover");
  });

  it("starts the page's reads with the navigation itself", () => {
    const ready = vi.fn();
    prepareWith(ready);
    navigate("/findings");
    expect(ready).toHaveBeenCalledWith("/findings", "open");
    history.replaceState(null, "", "/");
  });
});

const Page = () => null;

describe("lazyPage", () => {
  it("loads the code once, and again after a failed load", async () => {
    const load = vi
      .fn<() => Promise<{ Page: typeof Page }>>()
      .mockRejectedValueOnce(new Error("chunk gone"))
      .mockResolvedValue({ Page });
    const page = lazyPage(load, "Page");
    await expect(page.preload()).rejects.toThrow("chunk gone");
    await page.preload();
    await page.preload();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
