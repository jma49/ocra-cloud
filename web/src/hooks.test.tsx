import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadKeys } from "./account-keys.js";
import type { Me } from "./api.js";
import { PrefsProvider } from "./prefs.js";
import { matchRoute, placeHome, placeTabs, settingsGroups } from "./routes.js";
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
  const me = (codeGraphs: Me["codeGraphs"], autoReview = false): Me => ({
    login: "ada",
    githubId: 1,
    githubUrl: "https://github.com",
    avatarUrl: null,
    session: "web",
    since: "2026-11-01T00:00:00Z",
    codeGraphs,
    autoReview,
    platforms: ["github", "gitlab"],
  });
  const paths = (routes: { path: string }[]) => routes.map((r) => r.path);

  it("give each place its tabs and the settings their groups, in order", () => {
    const m = me("off");
    expect(paths(placeTabs("inbox", m))).toEqual(["/"]);
    expect(paths(placeTabs("reviews", m))).toEqual(["/reviews", "/activity", "/live"]);
    expect(paths(placeTabs("repositories", m))).toEqual([
      "/repositories",
      "/learnings",
      "/review-config",
      "/memory",
    ]);
    expect(paths(placeTabs("insights", m))).toEqual(["/insights", "/usage"]);
    expect(settingsGroups(m).map((g) => [g.label, paths(g.routes)])).toEqual([
      [
        "Review",
        ["/agents", "/review-settings", "/rules", "/automations", "/plugins", "/defaults"],
      ],
      ["Models & spend", ["/keys", "/budget"]],
      ["Account", ["/settings", "/notifications", "/sessions", "/audit"]],
    ]);
    expect(placeHome("settings")).toBe("/agents");
  });

  it("keep old and detail paths", () => {
    expect(matchRoute("/pulls")?.route.place).toBe("inbox");
    expect(matchRoute("/models")?.route.prefs).toBe(true);
    expect(matchRoute("/reviews/r%2F1")?.params).toEqual(["r/1"]);
    expect(matchRoute("/reviews/r%2F1")?.route.place).toBe("reviews");
    expect(matchRoute("/reviews/%E0")).toBeUndefined();
    expect(matchRoute("/keys")?.route.prefs).toBeUndefined();
    expect(matchRoute("/nope")).toBeUndefined();
    expect(matchRoute("/pull/github/octo%2Fapi/7")?.params).toEqual(["github", "octo/api", "7"]);
    expect(matchRoute("/pull/github/octo/api/7")?.params).toEqual(["github", "octo/api", "7"]);
    expect(matchRoute("/pull/gitlab/group/sub/project/3")?.params).toEqual([
      "gitlab",
      "group/sub/project",
      "3",
    ]);
    expect(matchRoute("/pull/github/7")).toBeUndefined();
  });

  it("show code graphs only where the server keeps them", () => {
    expect(paths(placeTabs("repositories", me("keep")))).toContain("/code-graphs");
    expect(paths(placeTabs("repositories", me("opt-in")))).toContain("/code-graphs");
    expect(paths(placeTabs("repositories", me("off")))).not.toContain("/code-graphs");
    expect(matchRoute("/code-graphs", me("keep"))).toBeDefined();
    expect(matchRoute("/code-graphs", me("off"))).toBeUndefined();
  });

  it("show auto review only where the server reviews pull requests itself", () => {
    expect(paths(placeTabs("repositories", me("off", true)))).toContain("/auto-review");
    expect(paths(placeTabs("repositories", me("off")))).not.toContain("/auto-review");
    expect(matchRoute("/auto-review", me("off", true))).toBeDefined();
    expect(matchRoute("/auto-review", me("off"))).toBeUndefined();
  });

  it("start the keys a page shows with /me, not after it (audit C11)", () => {
    for (const path of ["/usage", "/keys", "/agents", "/models", "/defaults"]) {
      expect(matchRoute(path)?.route.loads, path).toContain(loadKeys);
    }
    // Nothing for a page that does not show them: the read costs the server.
    expect(matchRoute("/sessions")?.route.loads).toBeUndefined();
  });
});
