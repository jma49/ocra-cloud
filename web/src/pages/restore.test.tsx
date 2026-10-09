import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { forgetKeys } from "../account-keys.js";
import { PrefsProvider } from "../prefs.js";
import { ToastProvider } from "../toast.js";
import { Defaults } from "./Defaults.js";

// Restoring a saved version says why it did not: a version today's rules
// refuse, and a restore that lost to saves landing at the same moment, are
// different things to do next (#92).

afterEach(() => {
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
});

const prefs = { runtime: null, models: {}, agents: {}, settings: {}, version: "v2" };
const versions = [
  { id: "v2", createdAt: "2026-10-09T00:00:00Z", changed: ["maxTasks"] },
  { id: "v1", createdAt: "2026-10-08T00:00:00Z", changed: ["maxTasks"] },
];

async function restoreAnswered(status: number, error: string): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, "");
      if (init?.method === "POST") return Response.json({ error }, { status });
      if (path === "/preferences") return Response.json(prefs);
      if (path === "/preferences/versions") return Response.json({ versions });
      return Response.json({ keys: [] });
    }),
  );
  render(
    <ToastProvider>
      <PrefsProvider>
        <Defaults />
      </PrefsProvider>
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  return (await screen.findByRole("status")).textContent ?? "";
}

it("says a restore that lost to saves at the same moment can be tried again", async () => {
  const said = await restoreAnswered(409, "stale");
  expect(said).toMatch(/at the same moment/);
  expect(said).not.toMatch(/today's rules/);
});

it("says a version today's rules refuse cannot be restored", async () => {
  expect(await restoreAnswered(422, "version_no_longer_valid")).toMatch(/today's rules/);
});

it("says why any other restore failed", async () => {
  expect(await restoreAnswered(429, "slow_down")).toMatch(/too many requests/);
});
