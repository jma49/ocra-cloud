import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "./account-keys.js";
import { Keys } from "./pages/Keys.js";
import { Memory } from "./pages/Memory.js";
import { Overview } from "./pages/Overview.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { Reviews } from "./pages/Reviews.js";
import { Rules } from "./pages/Rules.js";
import { Sessions } from "./pages/Sessions.js";
import { PrefsProvider } from "./prefs.js";
import { pageFor } from "./routes.js";
import { ToastProvider } from "./toast.js";
import { ErrorBoundary, forgetProviders } from "./ui.js";

// Honest states: a failure says what failed and why, loading is not "empty",
// and a bad address or a throwing page does not blank the console.

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>;
function fakeApi(handler: Handler) {
  const calls: { path: string; init?: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, "");
      calls.push({ path, init });
      return handler(path, init);
    }),
  );
  return calls;
}
const prefs = { runtime: null, models: {}, agents: {}, settings: {}, version: "v1" };
const me = { login: "ada", githubId: 1, session: "web" as const, since: "" };
const never = () => new Promise<Response>(() => {});

afterEach(() => {
  forgetProviders();
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saving settings", () => {
  const editAndSave = async () => {
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const field = await screen.findByLabelText("Most review tasks");
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    return (await screen.findByRole("alert")).textContent ?? "";
  };

  it("a 401 says signed out, not out of range", async () => {
    fakeApi((_p, init) =>
      init?.method === "PUT"
        ? Response.json({ error: "unauthenticated" }, { status: 401 })
        : Response.json(prefs),
    );
    const text = await editAndSave();
    expect(text).toMatch(/signed out/);
    expect(text).not.toMatch(/out of range/);
  });

  it("a network failure says the service could not be reached", async () => {
    fakeApi((_p, init) => {
      if (init?.method === "PUT") throw new TypeError("Failed to fetch");
      return Response.json(prefs);
    });
    expect(await editAndSave()).toMatch(/could not be reached/);
  });

  it("a 400 still names the value", async () => {
    fakeApi((_p, init) =>
      init?.method === "PUT"
        ? Response.json({ error: "invalid_body", issues: [] }, { status: 400 })
        : Response.json(prefs),
    );
    expect(await editAndSave()).toMatch(/out of range/);
  });

  it("an empty rule is not sent, so it does not fail the save", async () => {
    const calls = fakeApi((_p, init) =>
      init?.method === "PUT"
        ? Response.json({ ...JSON.parse(String(init.body)), version: "v2" })
        : Response.json(prefs),
    );
    render(
      <ToastProvider>
        <PrefsProvider>
          <Rules />
        </PrefsProvider>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Write your first rule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved");
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).settings.rules).toBeUndefined();
  });
});

describe("actions say when they fail", () => {
  const fail = () => Response.json({ error: "internal" }, { status: 500 });

  it("revoking a session", async () => {
    const session = {
      id: "s2",
      kind: "cli",
      label: null,
      createdAt: "2026-10-01T00:00:00Z",
      lastUsedAt: null,
      expiresAt: "2026-11-01T00:00:00Z",
      current: false,
    };
    fakeApi((_p, init) =>
      init?.method === "DELETE" ? fail() : Response.json({ sessions: [session] }),
    );
    render(<Sessions />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Could not revoke the session: ocra Cloud had an error/,
    );
  });

  it("forgetting a memory entry", async () => {
    const entry = {
      id: "m1",
      repo: "r",
      fingerprint: "f",
      file: null,
      title: "t",
      reason: "ok",
      createdAt: "2026-10-01T00:00:00Z",
    };
    fakeApi((_p, init) =>
      init?.method === "DELETE" ? fail() : Response.json({ entries: [entry] }),
    );
    render(<Memory />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not forget it/);
  });

  it("deleting a review record", async () => {
    const review = {
      id: "r1",
      runId: "run",
      repo: "abc",
      source: "local",
      tier: null,
      verdict: "approved",
      complete: true,
      findings: 0,
      critical: 0,
      warning: 0,
      suggestion: 0,
      filesReviewed: 1,
      filesNotReviewed: 0,
      tasksCompleted: 1,
      tasksFailed: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 1000,
      ocraVersion: null,
      createdAt: "2026-10-01T00:00:00Z",
    };
    const summary = {
      reviews: 1,
      repositories: 1,
      findings: 0,
      critical: 0,
      blocking: 0,
      incomplete: 0,
      fixed: 0,
      dismissed: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    fakeApi((_p, init) =>
      init?.method === "DELETE"
        ? fail()
        : Response.json({ days: 30, summary, reviewers: {}, reviews: [review] }),
    );
    render(<Reviews />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete this record" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not delete the record/);
  });

  it("deleting a key", async () => {
    const key = {
      provider: "openai",
      last4: "abcd",
      createdAt: "2026-10-01T00:00:00Z",
      checkStatus: null,
      checkedAt: null,
      checkable: false,
      lastUsedAt: null,
      calls7d: 0,
    };
    fakeApi((path, init) => {
      if (init?.method === "DELETE") return fail();
      if (path === "/providers") return Response.json({ providers: [] });
      return Response.json({ keys: [key] });
    });
    render(<Keys />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not delete the key/);
  });
});

describe("loading and load errors", () => {
  it("Sessions and Memory say when they could not load, and retry", async () => {
    let up = false;
    fakeApi((path) =>
      up
        ? Response.json(path === "/sessions" ? { sessions: [] } : { entries: [] })
        : Response.json({ error: "internal" }, { status: 500 }),
    );
    render(<Sessions />);
    await screen.findByText("Could not load your sessions");
    cleanup();
    render(<Memory />);
    await screen.findByText("Could not load memory");
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Nothing remembered yet");
  });

  it("Sessions and Memory show loading, not an empty table", async () => {
    fakeApi(never);
    render(<Sessions />);
    await screen.findByText(/Loading sessions/);
    cleanup();
    render(<Memory />);
    await screen.findByText(/Loading memory/);
    expect(screen.queryByText("Nothing remembered yet")).toBeNull();
  });

  it("Overview does not say no requests while they load", async () => {
    fakeApi(never);
    render(<Overview login="ada" />);
    await screen.findByText(/Loading requests/);
    expect(screen.queryByText(/No requests yet/)).toBeNull();
  });
});

describe("addresses and crashes", () => {
  it("a malformed review id is a 404 page, not a crash", () => {
    fakeApi(never);
    render(pageFor("/reviews/%E0", me));
    screen.getByText("Page not found");
  });

  it("an unknown path is a 404 page, not the overview", () => {
    fakeApi(never);
    render(pageFor("/no-such-page", me));
    screen.getByText("Page not found");
    expect(screen.queryByText(/Welcome/)).toBeNull();
  });

  it("a page that throws is caught, not a blank app", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("boom");
    };
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    screen.getByText("This page could not be shown");
  });
});
