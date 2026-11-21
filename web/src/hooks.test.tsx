import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadKeys } from "./account-keys.js";
import { PrefsProvider } from "./prefs.js";
import { matchRoute, NAV_GROUPS } from "./routes.js";
import { useLoad } from "./ui.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the preferences", () => {
  it("load when a configuration page first shows, once, and not before (#35)", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        asked.push(String(input));
        return Response.json({ runtime: null, models: {}, agents: {}, settings: {} });
      }),
    );
    const page = (idle: boolean) => (
      <PrefsProvider idle={idle}>
        <p>page</p>
      </PrefsProvider>
    );
    const { rerender } = render(page(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual([]);
    rerender(page(false));
    await waitFor(() => expect(asked).toEqual(["/api/preferences"]));
    rerender(page(true));
    rerender(page(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual(["/api/preferences"]);
  });
});

describe("useLoad", () => {
  it("shows no data from the previous deps while the new ones load, and says it is loading", async () => {
    let finish: (v: string) => void = () => {};
    const { result, rerender } = renderHook(
      ({ days }: { days: number }) =>
        useLoad(
          () => (days === 7 ? Promise.resolve("week") : new Promise<string>((r) => (finish = r))),
          [days],
        ),
      { initialProps: { days: 7 } },
    );
    await waitFor(() => expect(result.current.data).toBe("week"));
    expect(result.current.loading).toBe(false);
    rerender({ days: 30 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => finish("month"));
    expect(result.current).toMatchObject({ data: "month", loading: false });
  });
});

describe("the routes", () => {
  it("drive the sidebar in its order, and old and detail paths", () => {
    expect(NAV_GROUPS.map((g) => [g.label, g.routes.map((r) => r.path)])).toEqual([
      [
        "Console",
        ["/", "/pulls", "/activity", "/reviews", "/findings", "/insights", "/repositories"],
      ],
      [
        "Configure",
        [
          "/keys",
          "/agents",
          "/review-settings",
          "/rules",
          "/plugins",
          "/memory",
          "/budget",
          "/defaults",
        ],
      ],
      ["Account", ["/sessions", "/settings"]],
    ]);
    expect(matchRoute("/models")?.route.prefs).toBe(true);
    expect(matchRoute("/reviews/r%2F1")?.params).toEqual(["r/1"]);
    expect(matchRoute("/reviews/%E0")).toBeUndefined();
    expect(matchRoute("/keys")?.route.prefs).toBeUndefined();
    expect(matchRoute("/nope")).toBeUndefined();
  });

  it("start the keys a page shows with /me, not after it (audit C11)", () => {
    for (const path of ["/", "/keys", "/agents", "/models", "/defaults"]) {
      expect(matchRoute(path)?.route.loads, path).toContain(loadKeys);
    }
    // Nothing for a page that does not show them: the read costs the server.
    expect(matchRoute("/sessions")?.route.loads).toBeUndefined();
  });
});
