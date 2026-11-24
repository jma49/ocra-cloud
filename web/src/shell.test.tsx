import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { forgetRecentPulls, recentPulls, rememberPull } from "./recent-pulls.js";
import { matchRoute } from "./routes.js";
import { Frame } from "./shell.js";
import { PageHead } from "./ui.js";

const me: Me = {
  login: "sample-user",
  githubId: null,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web",
  since: "2026-11-01T00:00:00Z",
  codeGraphs: "keep",
  autoReview: true,
  platforms: ["github", "gitlab"],
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
    const input = await screen.findByPlaceholderText("Search or go to…");
    fireEvent.change(input, { target: { value: "insights" } });
    const usage = await screen.findByRole("option", { name: /^Usage/ });
    expect(screen.queryByRole("option", { name: /^Inbox/ })).toBeNull();
    fireEvent.click(usage);
    expect(location.pathname).toBe("/usage");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("theme", () => {
  it("is chosen from the command menu and kept in this browser", async () => {
    history.replaceState(null, "", "/");
    localStorage.removeItem("ocra.theme");
    render(
      <Frame me={me} route={matchRoute("/")?.route} path="/">
        <p>page</p>
      </Frame>,
    );
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText("Search or go to…");
    fireEvent.change(input, { target: { value: "dark" } });
    fireEvent.click(await screen.findByRole("option", { name: /Use the dark theme/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ocra.theme")).toBe("dark");
    localStorage.removeItem("ocra.theme");
  });
});

describe("rail", () => {
  it("carries each place's name and keys, which show as the rail opens", () => {
    history.replaceState(null, "", "/");
    render(
      <Frame me={me} route={matchRoute("/")?.route} path="/">
        <p>page</p>
      </Frame>,
    );
    const insights = screen.getByRole("link", { name: "Insights" });
    expect(insights.getAttribute("title")).toBeNull();
    expect(insights.querySelector(".rail-label")?.textContent).toBe("Insights");
    expect(insights.querySelector(".rail-key")?.textContent).toBe("gn");
  });

  it("lets go of a link clicked with the pointer, so it closes when the pointer leaves", () => {
    history.replaceState(null, "", "/");
    render(
      <Frame me={me} route={matchRoute("/")?.route} path="/">
        <p>page</p>
      </Frame>,
    );
    const insights = screen.getByRole("link", { name: "Insights" });
    insights.focus();
    fireEvent.click(insights, { detail: 1 });
    expect(document.activeElement).not.toBe(insights);
    insights.focus();
    fireEvent.click(insights, { detail: 0 });
    expect(document.activeElement).toBe(insights);
  });
});

describe("page head", () => {
  const head = (path: string) => {
    history.replaceState(null, "", path);
    render(
      <Frame me={me} route={matchRoute(path)?.route} path={path}>
        <PageHead title="Title" sub="What the page is for." note="What it does with your code." />
      </Frame>,
    );
    return screen.getByRole("heading", { level: 1, name: "Title" });
  };

  it("leaves a place's tab to the bar's name, keeping only its note", () => {
    expect(head("/findings").className).toBe("sr-only");
    expect(screen.queryByText("What the page is for.")).toBeNull();
    expect(screen.getByText("What it does with your code.")).not.toBeNull();
  });

  it("keeps a settings page's title and sentence", () => {
    expect(head("/sessions").className).toBe("");
    expect(screen.getByText("What the page is for.")).not.toBeNull();
  });
});

describe("recent pull requests", () => {
  it("offers the ones opened last before anything is typed", async () => {
    history.replaceState(null, "", "/pull/github/acme%2Fweb/8");
    rememberPull({ to: "/pull/github/acme/web/7", title: "Cache the pricing", ref: "acme/web #7" });
    rememberPull({ to: "/pull/github/acme/web/8", title: "Open right now", ref: "acme/web #8" });
    render(
      <Frame me={me} route={matchRoute("/")?.route} path="/">
        <p>page</p>
      </Frame>,
    );
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const recent = await screen.findByRole("option", { name: /Cache the pricing/ });
    expect(screen.queryByRole("option", { name: /Open right now/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or go to…"), {
      target: { value: "usage" },
    });
    await waitFor(() => expect(recent.isConnected).toBe(false));
    forgetRecentPulls();
    expect(recentPulls()).toEqual([]);
  });
});
