import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { Repositories } from "./Repositories.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const platform = (over: object) => ({
  linked: false,
  failed: false,
  more: false,
  repositories: [],
  ...over,
});

describe("the connected platforms", () => {
  it("offer to connect GitLab, and say how GitHub is linked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/platforms/repos"
          ? Response.json({
              sharing: false,
              platforms: [
                platform({ platform: "github", host: "github.com" }),
                platform({ platform: "gitlab", host: "gitlab.example.com" }),
              ],
            })
          : Response.json({ repositories: [] }),
      ),
    );
    render(<Repositories />);
    const connect = await screen.findByRole("link", { name: "Connect GitLab" });
    expect(connect.getAttribute("href")).toBe("/api/platforms/gitlab/connect");
    expect(screen.getAllByRole("link", { name: /Connect/ })).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(/Sign out and sign in again/)).toBeTruthy());
  });
});
