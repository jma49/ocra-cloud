import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { matchRoute } from "./routes.js";
import { Frame } from "./shell.js";

const me: Me = {
  login: "sample-user",
  githubId: null,
  session: "web",
  since: "2026-11-01T00:00:00Z",
  codeGraphs: "keep",
  autoReview: true,
};

type Box = { scrollWidth: number; clientWidth: number; offsetLeft: number; offsetWidth: number };
function layout(box: Box) {
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, "scrollWidth", "get").mockReturnValue(box.scrollWidth);
  vi.spyOn(proto, "clientWidth", "get").mockReturnValue(box.clientWidth);
  vi.spyOn(proto, "offsetLeft", "get").mockReturnValue(box.offsetLeft);
  vi.spyOn(proto, "offsetWidth", "get").mockReturnValue(box.offsetWidth);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("settings nav", () => {
  it("scrolls a phone's row of settings to centre the open page", () => {
    layout({ scrollWidth: 1286, clientWidth: 390, offsetLeft: 900, offsetWidth: 120 });
    render(
      <Frame me={me} route={matchRoute("/sessions")?.route} path="/sessions">
        <p>page</p>
      </Frame>,
    );
    expect(screen.getByRole("navigation", { name: "Settings" }).scrollLeft).toBe(765);
  });

  it("leaves the nav alone when it fits", () => {
    layout({ scrollWidth: 232, clientWidth: 232, offsetLeft: 0, offsetWidth: 200 });
    render(
      <Frame me={me} route={matchRoute("/sessions")?.route} path="/sessions">
        <p>page</p>
      </Frame>,
    );
    expect(screen.getByRole("navigation", { name: "Settings" }).scrollLeft).toBe(0);
  });
});

describe("command menu", () => {
  it("opens on Ctrl+K, finds a page by its place's name and goes there", async () => {
    history.replaceState(null, "", "/");
    render(
      <Frame me={me} route={matchRoute("/")?.route} path="/">
        <p>page</p>
      </Frame>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText("Go to…");
    fireEvent.change(input, { target: { value: "insights" } });
    const usage = await screen.findByRole("option", { name: "Usage" });
    expect(screen.queryByRole("option", { name: "Inbox" })).toBeNull();
    fireEvent.click(usage);
    expect(location.pathname).toBe("/usage");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
