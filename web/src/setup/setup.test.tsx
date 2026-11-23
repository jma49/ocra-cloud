import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SETUP_SETTINGS, type SetupSettingsView } from "../../../src/shared/index.js";
import { ToastProvider } from "../toast.js";
import { Setup } from "./Setup.js";

// The server's settings page: closed until the setup code opens it, then a
// step per connection, where a setting the environment sets is locked and a
// saved secret is never shown.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view: SetupSettingsView = {
  fields: Object.fromEntries(
    SETUP_SETTINGS.map((n) => [n, { set: false }]),
  ) as SetupSettingsView["fields"],
  addresses: {
    signIn: "https://ocra.example.com/api/auth/oidc/callback",
    gitlab: "https://ocra.example.com/api/platforms/gitlab/callback",
    github: "https://ocra.example.com/api/auth/github/callback",
    githubWebhook: "https://ocra.example.com/api/webhooks/github",
  },
};
view.fields["signIn.issuer"] = { set: true, lockedBy: "OIDC_ISSUER" };
view.fields["signIn.clientSecret"] = { set: true };

function serve(open: { value: boolean }) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/setup/unlock") {
        const body = JSON.parse(String(init?.body)) as { code: string };
        open.value = body.code === "ABCD-EFGH-JKMN-PQRS";
        return open.value
          ? Response.json({ ok: true })
          : Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      if (!open.value) return Response.json({ error: "unauthenticated" }, { status: 401 });
      return Response.json(view);
    }),
  );
  return calls;
}

const page = () =>
  render(
    <ToastProvider>
      <Setup />
    </ToastProvider>,
  );

it("opens only with the setup code, saying where to find it", async () => {
  serve({ value: false });
  page();
  const code = await screen.findByLabelText("Setup code");
  expect(screen.getByText("docker compose logs ocra")).toBeTruthy();
  fireEvent.change(code, { target: { value: "WRONG" } });
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "That is not this server's code. Check it against the log.",
  );
  fireEvent.change(code, { target: { value: "ABCD-EFGH-JKMN-PQRS" } });
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  expect(await screen.findByRole("navigation", { name: "Setup steps" })).toBeTruthy();
});

it("locks a setting the environment sets, and keeps a saved secret unless one is typed", async () => {
  const calls = serve({ value: true });
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Sign-in" }));
  const issuer = screen.getByLabelText("Issuer") as HTMLInputElement;
  expect(issuer.disabled).toBe(true);
  expect(
    screen.getByText("Set by OIDC_ISSUER in the server's environment, which wins."),
  ).toBeTruthy();
  const secret = screen.getByLabelText("Client secret") as HTMLInputElement;
  expect(secret.value).toBe("");
  expect(secret.placeholder).toBe("Saved: type to replace it");
  expect(screen.getByText(view.addresses.signIn)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "ocra" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/The server uses saved settings once it starts again/);
  const put = calls.find((c) => c.path === "/api/setup/settings" && c.body);
  expect(put?.body).toEqual({ values: { "signIn.clientId": "ocra" } });
});
