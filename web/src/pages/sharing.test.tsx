import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = {
  login: "ada",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web" as const,
  since: "2026-10-01T00:00:00Z",
  codeGraphs: "off" as const,
  autoReview: false,
  platforms: ["github", "gitlab"] as const,
};
const never = () => new Promise<Response>(() => {});

/** GET /api/account/sharing answers with `sharing`; anything else fails. */
function fakeSharing(sharing: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) =>
      String(input).endsWith("/account/sharing") && init?.method !== "PUT"
        ? sharing()
        : Response.json({ error: "internal" }, { status: 500 }),
    ),
  );
}

const dataKept = () => screen.getByText("Data kept").nextElementSibling?.textContent ?? "";

describe("sharing findings", () => {
  it("says so when turning sharing off fails, and keeps the choice open", async () => {
    fakeSharing(() =>
      Response.json({ shareFindings: true, findingsStored: 3, findingsAllowance: 1000 }),
    );
    render(<Settings me={me} />);
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByText("Turn off and delete"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not change/));
    expect(screen.getByText("Turn off and delete")).toBeTruthy();
  });

  it("does not say no code is kept while findings and their code are sent (audit C2)", async () => {
    fakeSharing(() =>
      Response.json({ shareFindings: true, findingsStored: 3, findingsAllowance: 1000 }),
    );
    render(<Settings me={me} />);
    expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe("true");
    expect(dataKept()).toMatch(/the code they quote/);
    expect(dataKept()).not.toMatch(/No code/);
  });

  it("says no code is kept while nothing is sent", async () => {
    fakeSharing(() =>
      Response.json({ shareFindings: false, findingsStored: 0, findingsAllowance: 1000 }),
    );
    render(<Settings me={me} />);
    expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe("false");
    expect(dataKept()).toMatch(/No code, prompts or answers/);
  });

  it("shows the setting loading, and says no code is kept only once it is known", async () => {
    fakeSharing(never);
    render(<Settings me={me} />);
    await screen.findByText(/Loading the sharing setting/);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(dataKept()).toMatch(/prompts or answers/);
    expect(dataKept()).not.toMatch(/No code/);
  });

  it("says when the setting could not load, and tries again", async () => {
    let up = false;
    fakeSharing(() =>
      up
        ? Response.json({ shareFindings: false, findingsStored: 0, findingsAllowance: 1000 })
        : Response.json({ error: "internal" }, { status: 500 }),
    );
    render(<Settings me={me} />);
    await screen.findByText("Could not load the sharing setting");
    expect(dataKept()).not.toMatch(/No code/);
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe("false");
  });

  it("says how many findings may be sent and that deleting them gives no room back", async () => {
    fakeSharing(() =>
      Response.json({ shareFindings: true, findingsStored: 3, findingsAllowance: 1000 }),
    );
    render(<Settings me={me} />);
    await screen.findByRole("switch");
    screen.getByText(/Up to 1,000 findings can be sent in any 90 days; deleting findings/);
  });

  it("offers to keep hosted reviews' findings where the server runs reviews, and says their code is kept", async () => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT") sent.push({ url: input, body: JSON.parse(String(init.body)) });
        return Response.json({
          shareFindings: false,
          hostedFindings: true,
          findingsStored: 4,
          findingsAllowance: 1000,
        });
      }),
    );
    render(<Settings me={{ ...me, autoReview: true }} />);
    const hosted = await screen.findByRole("switch", {
      name: "Keep the findings of reviews ocra runs here",
    });
    expect(hosted.getAttribute("aria-checked")).toBe("true");
    expect(dataKept()).toMatch(/for reviews ocra runs here, also their findings and the code/);
    expect(dataKept()).not.toMatch(/No code/);
    fireEvent.click(hosted);
    screen.getByText(/Delete the 4 already stored too\?/);
    fireEvent.click(screen.getByText("Turn off, keep them"));
    await waitFor(() =>
      expect(sent).toEqual([
        { url: "/api/account/sharing/hosted", body: { enabled: false, deleteExisting: false } },
      ]),
    );
  });

  it("shows no hosted switch where the server runs no reviews", async () => {
    fakeSharing(() =>
      Response.json({
        shareFindings: false,
        hostedFindings: true,
        findingsStored: 0,
        findingsAllowance: 1000,
      }),
    );
    render(<Settings me={me} />);
    await screen.findByRole("switch");
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(dataKept()).toMatch(/No code/);
  });
});
