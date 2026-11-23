import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "./account-keys.js";
import { clearCache } from "./cache.js";
import { Activity } from "./pages/Activity.js";
import { BudgetPage } from "./pages/Budget.js";
import { Keys } from "./pages/Keys.js";
import { Plugins } from "./pages/Plugins.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { PrefsProvider } from "./prefs.js";
import { ToastProvider } from "./toast.js";
import { forgetProviders } from "./ui.js";

// Data that has not arrived, or failed to, is never shown as "nothing yet",
// and every failed load offers a retry in the place the content goes.

type Handler = (path: string) => Response | Promise<Response>;
function fakeApi(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/^\/api/, "");
      calls.push(path);
      return handler(path);
    }),
  );
  return calls;
}
const never = () => new Promise<Response>(() => {});
const fail = () => Response.json({ error: "internal" }, { status: 500 });
const prefs = { runtime: null, models: {}, agents: {}, settings: {}, version: "v1" };
const withPrefs = (page: React.ReactNode) => (
  <ToastProvider>
    <PrefsProvider>{page}</PrefsProvider>
  </ToastProvider>
);

beforeEach(() => clearCache());
afterEach(() => {
  forgetProviders();
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings pages wait for the settings", () => {
  it("Rules shows a skeleton, not 'No rules yet', before they arrive", () => {
    fakeApi(never);
    render(withPrefs(<Rules />));
    expect(screen.getByRole("status").textContent).toBe("Loading your settings…");
    expect(screen.queryByText("No rules yet")).toBeNull();
  });

  it("Plugins says it could not load them, and a retry loads them", async () => {
    let up = false;
    const calls = fakeApi((path) =>
      up && path === "/preferences" ? Response.json(prefs) : fail(),
    );
    render(withPrefs(<Plugins />));
    expect(await screen.findByText("Could not load your settings")).toBeTruthy();
    expect(screen.queryByText("No plugins yet")).toBeNull();
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No plugins yet")).toBeTruthy();
    expect(calls.filter((p) => p === "/preferences")).toHaveLength(2);
  });
});

describe("pages that read one list", () => {
  it("Activity does not say there are no requests while they load", () => {
    fakeApi(never);
    render(<Activity />);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No requests/)).toBeNull();
  });

  it("Activity offers a retry when it could not load", async () => {
    fakeApi(fail);
    render(<Activity />);
    expect(await screen.findByText("Could not load activity")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/No requests/)).toBeNull();
  });

  it("Keys offers a retry instead of an empty table", async () => {
    fakeApi((path) => (path === "/providers" ? Response.json({ providers: [] }) : fail()));
    render(<Keys />);
    expect(await screen.findByText("Could not load your keys")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("Reviews stops its skeleton and offers a retry when it could not load", async () => {
    fakeApi(fail);
    render(<Reviews />);
    expect(await screen.findByText("Could not load reviews")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Budget keeps its title while it loads", () => {
    fakeApi(never);
    render(<BudgetPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Budget");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("a failed load does not tell the person to try again twice", async () => {
    fakeApi(fail);
    render(<BudgetPage />);
    expect(await screen.findByText("ocra Cloud had an error.")).toBeTruthy();
  });
});
