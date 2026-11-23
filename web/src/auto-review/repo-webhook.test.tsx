import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReviewRepoView } from "../../../src/shared/index.js";
import { Hook } from "./hook-card.js";
import { RepoWebhook } from "./repo-webhook.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPO: AutoReviewRepoView = {
  id: "rr1",
  platform: "gitlab",
  host: "gitlab.example.com",
  fullName: "pay/api",
  profile: "balanced",
  automatic: false,
  learn: "merge",
  hasAccessToken: false,
  accessTokenBot: null,
  webhookManaged: false,
  paused: null,
  latest: null,
};
const URL = "https://ocra.example.com/api/auto-review/webhooks/gitlab";

const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("a GitLab project's webhook", () => {
  it("says the webhook was added, with nothing to copy, when ocra added it", () => {
    render(
      <Hook
        added={{ repo: REPO, webhook: { url: URL, secret: "ocra_hook_s3cret", managed: true } }}
        onDone={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Webhook added" })).toBeTruthy();
    expect(screen.queryByLabelText("Secret token")).toBeNull();
    expect(screen.queryByText(/ocra_hook_s3cret/)).toBeNull();
  });

  it("says why ocra could not add it, beside the address and the secret", () => {
    render(
      <Hook
        added={{
          repo: REPO,
          webhook: {
            url: URL,
            secret: "ocra_hook_s3cret",
            managed: false,
            problem: "the token needs the Maintainer role",
          },
        }}
        onDone={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "ocra could not add the webhook itself: the token needs the Maintainer role.",
    );
    expect((screen.getByLabelText("Webhook address") as HTMLInputElement).value).toBe(URL);
    expect((screen.getByLabelText("Secret token") as HTMLInputElement).value).toBe(
      "ocra_hook_s3cret",
    );
  });

  it("sets the webhook up from the row and shows its new secret once", async () => {
    const sent: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, method: init?.method });
        return Response.json({ url: URL, secret: "ocra_hook_new", managed: true });
      }),
    );
    const changed = vi.fn();
    render(<RepoWebhook r={REPO} onChanged={changed} />);
    expect(screen.getByText(/keeps the old secret and is no longer accepted/)).toBeTruthy();
    await press("Set up webhook");
    expect(sent).toEqual([{ url: "/api/auto-review/repos/rr1/webhook", method: "POST" }]);
    expect(screen.getByText("ocra_hook_new")).toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("offers to re-create a webhook ocra added, and says why GitLab refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "invalid_body",
            issues: [{ path: ["webhook"], message: "the token needs the Maintainer role" }],
          },
          { status: 400 },
        ),
      ),
    );
    const changed = vi.fn();
    render(<RepoWebhook r={{ ...REPO, webhookManaged: true }} onChanged={changed} />);
    await press("Re-create webhook");
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not add the webhook: the token needs the Maintainer role.",
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("says GitLab did not answer when the hook could not be sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "upstream_unreachable" }, { status: 502 })),
    );
    render(<RepoWebhook r={REPO} onChanged={() => {}} />);
    await press("Set up webhook");
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not add the webhook: GitLab did not answer; try again.",
    );
  });

  it("makes a new secret for a hook added by hand only after a second press", async () => {
    const sent: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, method: init?.method });
        return Response.json({
          url: URL,
          secret: "ocra_hook_hand",
          events: ["Merge request events", "Comments", "Pipeline events"],
        });
      }),
    );
    const changed = vi.fn();
    render(<RepoWebhook r={REPO} onChanged={changed} />);
    await press("New secret");
    expect(sent).toEqual([]);
    expect(screen.getByText(/holds the old secret is no longer accepted/)).toBeTruthy();
    await press("Confirm: new secret");
    expect(sent).toEqual([{ url: "/api/auto-review/repos/rr1/webhook/secret", method: "POST" }]);
    expect((screen.getByLabelText("Webhook address") as HTMLInputElement).value).toBe(URL);
    expect(
      screen.getByText("Turn on Merge request events, Comments, Pipeline events."),
    ).toBeTruthy();
    expect(screen.getByText("ocra_hook_hand")).toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("says another change replaced the secret at the same moment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "stale" }, { status: 409 })),
    );
    render(<RepoWebhook r={REPO} onChanged={() => {}} />);
    await press("New secret");
    await press("Confirm: new secret");
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not make a new secret: the secret was replaced at the same moment; try again.",
    );
  });
});
