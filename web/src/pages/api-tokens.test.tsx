import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenView } from "../../../src/shared/index.js";
import { ApiTokens } from "./ApiTokens.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SECRET = "ocra_pat_synthetic-secret-for-the-test";
const token = (id: string, name: string, more: Partial<ApiTokenView> = {}): ApiTokenView => ({
  id,
  name,
  scopes: ["reviews:read", "pulls:read"],
  prefix: "ocra_pat_a1b2c3",
  createdAt: "2026-11-20T10:00:00Z",
  lastUsedAt: null,
  expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
  ...more,
});

type Sent = { url: string; method: string; body: unknown };
function serve(tokens: ApiTokenView[], refuse = false) {
  const sent: Sent[] = [];
  let list = tokens;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).endsWith("/auth/methods"))
        return Response.json({ methods: [{ id: "github", name: "GitHub" }] });
      if (method === "GET") return Response.json({ tokens: list });
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "DELETE") {
        list = list.filter((t) => !url.endsWith(t.id));
        return Response.json({ removed: true });
      }
      if (refuse)
        return Response.json(
          { error: "forbidden_for_session", reason: "recent_sign_in" },
          { status: 403 },
        );
      const made = token("t9", "Nightly report", { scopes: ["insights:read"] });
      list = [made, ...list];
      return Response.json({ token: made, secret: SECRET }, { status: 201 });
    }),
  );
  return sent;
}

const fill = (form: HTMLElement) => {
  fireEvent.change(within(form).getByLabelText("Token name"), {
    target: { value: " Nightly report " },
  });
  fireEvent.click(within(form).getByLabelText("Insights"));
  fireEvent.click(within(form).getByRole("button", { name: "90 days" }));
};

describe("the API tokens page", () => {
  it("lists each token without a secret and revokes one only after a second press", async () => {
    const sent = serve([
      token("t1", "CI gate", { lastUsedAt: new Date(Date.now() - 7_200_000).toISOString() }),
      token("t2", "Old script", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ]);
    render(<ApiTokens />);
    const row = (await screen.findByText("CI gate")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Reviews, Pull requests")).toBeTruthy();
    expect(within(row).getByText("ocra_pat_a1b2c3…")).toBeTruthy();
    expect(within(row).getByText("2h ago")).toBeTruthy();
    expect(within(row).queryByText("Soon")).toBeNull();
    const old = screen.getByText("Old script").closest("tr") as HTMLElement;
    expect(within(old).getByText("Never")).toBeTruthy();
    expect(within(old).getByText("Soon")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Old script" }));
    expect(sent).toEqual([]);
    fireEvent.click(within(old).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke Old script" }));
    await act(
      async () =>
        void fireEvent.click(within(old).getByRole("button", { name: "Confirm: revoke" })),
    );
    expect(sent).toEqual([{ url: "/api/tokens/t2", method: "DELETE", body: undefined }]);
    await waitFor(() => expect(screen.queryByText("Old script")).toBeNull());
  });

  it("makes a token with what was ticked, shows its secret once and forgets it on Done", async () => {
    const sent = serve([]);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ApiTokens />);
    fireEvent.click(await screen.findByRole("button", { name: "New token" }));
    const form = screen.getByRole("form", { name: "New API token" });
    expect(within(form).getByText(/GET \/api\/insights\/cycle/)).toBeTruthy();
    const make = within(form).getByRole("button", { name: "Make token" });
    expect(make.hasAttribute("disabled")).toBe(true);
    fill(form);
    await act(async () => void fireEvent.click(make));
    expect(sent).toEqual([
      {
        url: "/api/tokens",
        method: "POST",
        body: { name: "Nightly report", scopes: ["insights:read"], expiresInDays: 90 },
      },
    ]);
    expect(screen.queryByRole("form", { name: "New API token" })).toBeNull();
    const shown = await screen.findByRole("region", { name: "Your new token" });
    expect(within(shown).getByText(SECRET)).toBeTruthy();
    await act(
      async () => void fireEvent.click(within(shown).getByRole("button", { name: "Copy token" })),
    );
    expect(writeText).toHaveBeenCalledWith(SECRET);
    fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText("Nightly report")).toBeTruthy();
  });

  it("offers a fresh sign-in when making a token needs one, and keeps the form", async () => {
    serve([], true);
    history.replaceState(null, "", "/tokens");
    render(<ApiTokens />);
    fireEvent.click(await screen.findByRole("button", { name: "New token" }));
    const form = screen.getByRole("form", { name: "New API token" });
    fill(form);
    await act(
      async () => void fireEvent.click(within(form).getByRole("button", { name: "Make token" })),
    );
    expect(within(form).getByRole("alert").textContent).toMatch(/sign-in within/);
    const link = await within(form).findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/api/auth/github/login?next=%2Ftokens");
    expect((within(form).getByLabelText("Token name") as HTMLInputElement).value).toBe(
      " Nightly report ",
    );
  });

  it("stops offering a new token at the most an account holds", async () => {
    serve(Array.from({ length: 20 }, (_, i) => token(`t${i}`, `Job ${i}`)));
    render(<ApiTokens />);
    expect(await screen.findByText(/20 tokens is the most/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "New token" }).hasAttribute("disabled")).toBe(true);
  });
});
