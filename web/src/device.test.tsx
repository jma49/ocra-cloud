import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Device } from "./pages/Device.js";

// Audit S-hard (#15): the terminal's name on the approval page is chosen by
// whoever asked for the code, so it is marked unverified.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("approving a terminal", () => {
  it("labels the requester-chosen name as unverified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          user_code: "BCDF-GHJK",
          label: "Your work laptop",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    window.history.replaceState(null, "", "/device?code=BCDF-GHJK");
    render(<Device />);
    const name = await screen.findByText(/Your work laptop/);
    expect(name.textContent).toMatch(/unverified/i);
    expect(name.textContent).toMatch(/cannot check/);
  });
});
