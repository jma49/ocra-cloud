import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphRepoView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { CodeGraphs } from "./CodeGraphs.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const repo = (latest: Partial<NonNullable<GraphRepoView["latest"]>> | null): GraphRepoView => ({
  id: "g1",
  platform: "github",
  host: "github.com",
  fullName: "octo/api",
  url: "https://github.com/octo/api",
  identity: "https://github.com/octo/api",
  branch: "main",
  latest: latest && {
    commit: "a".repeat(40),
    state: "done",
    files: 1200,
    bytes: 2_400_000,
    truncated: false,
    error: null,
    finishedAt: new Date().toISOString(),
    ...latest,
  },
});

function fakeApi(repos: GraphRepoView[], answers: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (key in answers) return Response.json(answers[key]);
    if (key === "GET /api/graphs/repos") return Response.json({ repos });
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the code graphs page", () => {
  it("lists each repository's newest build", async () => {
    fakeApi([repo({}), { ...repo({ state: "failed", error: "unlinked" }), id: "g2" }]);
    render(<CodeGraphs policy="keep" />);
    await screen.findByText("Built");
    expect(screen.getAllByText("aaaaaaa")).toHaveLength(2);
    expect(screen.getAllByText("1,200")).toHaveLength(2);
    expect(screen.getAllByText("2.3 MB")).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/no longer connected to the platform/)).toBeTruthy();
  });

  it("rebuilds a graph and shows the queued build", async () => {
    const fetch = fakeApi([repo({ state: "failed", error: "build_failed" })], {
      "POST /api/graphs/repos/g1/builds": { queued: true, repo: repo({ state: "queued" }) },
    });
    render(<CodeGraphs policy="keep" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
    await screen.findByText("Queued");
    expect(fetch).toHaveBeenCalledWith(
      "/api/graphs/repos/g1/builds",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByRole("button", { name: "Rebuild" }).hasAttribute("disabled")).toBe(true);
    // A purge leaves a running build to finish, so the row would not be empty.
    expect(screen.getByRole("button", { name: "Purge" }).hasAttribute("disabled")).toBe(true);
  });

  it("purges a graph only after a second click, and puts it back when the server refuses", async () => {
    const fetch = fakeApi([repo({})]);
    render(<CodeGraphs policy="keep" />);
    fireEvent.click(await screen.findByRole("button", { name: "Purge" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/graphs/repos/g1/graphs", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Delete graphs" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/graphs/repos/g1/graphs",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await screen.findByRole("alert");
    expect(screen.getByText("Built")).toBeTruthy();
  });

  it("asks for consent before adding where the server keeps graphs only with it", async () => {
    fakeApi([]);
    render(<CodeGraphs policy="opt-in" />);
    await screen.findByText("No code graphs yet");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "octo/api" } });
    const add = screen.getByRole("button", { name: "Add repository" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(add.hasAttribute("disabled")).toBe(false);
  });

  it("says so where the server keeps none, and reads nothing", () => {
    const fetch = fakeApi([]);
    render(<CodeGraphs policy="off" />);
    expect(screen.getByText("This server keeps no code graphs")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
