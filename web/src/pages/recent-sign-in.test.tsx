import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";

// Audit C7: a destructive change refused for an old sign-in says so and
// offers a fresh one that comes back to the page.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = {
  login: "ada",
  githubId: 1,
  session: "web" as const,
  since: "2026-10-01T00:00:00Z",
  codeGraphs: "off" as const,
  autoReview: false,
  platforms: ["github", "gitlab"] as const,
};

it("offers a fresh sign-in when deleting the account needs one", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) =>
      String(input).endsWith("/auth/methods")
        ? Response.json({ methods: [{ id: "github", name: "GitHub" }] })
        : init?.method === "DELETE"
          ? Response.json(
              { error: "forbidden_for_session", reason: "recent_sign_in" },
              { status: 403 },
            )
          : Response.json({ shareFindings: false, findingsStored: 0, findingsAllowance: 1000 }),
    ),
  );
  history.replaceState(null, "", "/settings");
  render(<Settings me={me} />);
  fireEvent.change(screen.getByLabelText("Type your login to confirm"), {
    target: { value: "ada" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/sign-in within/));
  const link = await screen.findByRole("link", { name: "Sign in again" });
  expect(link.getAttribute("href")).toBe("/api/auth/github/login?next=%2Fsettings");
});
