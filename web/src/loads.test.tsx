import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { forgetKeys } from "./account-keys.js";
import { Keys } from "./pages/Keys.js";
import { Overview } from "./pages/Overview.js";
import { forgetProviders } from "./ui.js";

// Audit C11: /keys runs a 90-day aggregate on the server, and four pages
// read it: moving between them asks once, and a key change asks again.

afterEach(() => {
  forgetKeys();
  forgetProviders();
  cleanup();
  vi.unstubAllGlobals();
});

it("reads the keys once for the pages that show them, and again after a change", async () => {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/^\/api/, "");
      asked.push(path);
      if (path === "/providers") return Response.json({ providers: [] });
      if (path === "/keys") return Response.json({ keys: [] });
      return Response.json({
        days: 14,
        today: 0,
        dailyLimit: 1000,
        series: [],
        models: [],
        calls: [],
      });
    }),
  );
  const keyReads = () => asked.filter((p) => p === "/keys").length;
  const first = render(<Overview />);
  await waitFor(() => expect(keyReads()).toBe(1));
  first.unmount();
  render(<Keys />);
  await screen.findByRole("button", { name: "Add your first key" });
  expect(keyReads()).toBe(1);
  forgetKeys();
  cleanup();
  render(<Keys />);
  await waitFor(() => expect(keyReads()).toBe(2));
});
