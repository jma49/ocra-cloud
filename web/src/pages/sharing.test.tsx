import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sharing } from "./Settings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sharing findings", () => {
  it("says so when turning sharing off fails, and keeps the choice open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? Response.json({ error: "internal" }, { status: 500 })
          : Response.json({ shareFindings: true, findingsStored: 3 }),
      ),
    );
    render(<Sharing />);
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByText("Turn off and delete"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not change/));
    expect(screen.getByText("Turn off and delete")).toBeTruthy();
  });
});
