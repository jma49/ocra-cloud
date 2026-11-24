import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReviewRepoView } from "../../../src/shared/index.js";
import { AccessToken } from "./access-token.js";
import { jobError } from "./job-error.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPO: AutoReviewRepoView = {
  id: "rr1",
  platform: "gitlab",
  host: "gitlab.example.com",
  fullName: "pay/api",
  depth: "standard",
  automatic: false,
  learn: "merge",
  restack: false,
  mend: "propose",
  mendChecks: false,
  hasAccessToken: false,
  accessTokenBot: null,
  webhookManaged: false,
  paused: null,
  latest: null,
};
const WITH_TOKEN = { ...REPO, hasAccessToken: true, accessTokenBot: "project_7_bot" };

const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("a GitLab project's access token", () => {
  it("saves a token once, then forgets what was typed", async () => {
    const sent: { url: string; method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({ hasAccessToken: true, accessTokenBot: "project_7_bot" });
      }),
    );
    const changed = vi.fn();
    render(<AccessToken r={REPO} onChanged={changed} />);
    expect(screen.getByText(/as the server's bot/)).toBeTruthy();
    const field = screen.getByLabelText("Project access token") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sample-token" } });
    await press("Save");
    expect(sent).toEqual([
      {
        url: "/api/auto-review/repos/rr1/access-token",
        method: "PUT",
        body: { token: "sample-token" },
      },
    ]);
    expect(field.value).toBe("");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("names the bot of a kept token, never the token, and removes it", async () => {
    const sent: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(init?.method);
        return Response.json({ hasAccessToken: false, accessTokenBot: null });
      }),
    );
    const changed = vi.fn();
    render(<AccessToken r={WITH_TOKEN} onChanged={changed} />);
    expect(screen.getByText("project_7_bot")).toBeTruthy();
    expect((screen.getByLabelText("New project access token") as HTMLInputElement).value).toBe("");
    await press("Remove token");
    expect(sent).toEqual(["DELETE"]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("says in the server's words why GitLab's answer refused a token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "invalid_body",
            issues: [{ path: ["token"], message: "the token needs the api scope" }],
          },
          { status: 400 },
        ),
      ),
    );
    const changed = vi.fn();
    render(<AccessToken r={REPO} onChanged={changed} />);
    fireEvent.change(screen.getByLabelText("Project access token"), { target: { value: "x" } });
    await press("Save");
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not save the token: the token needs the api scope.",
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("says GitLab did not answer when the check could not reach it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "upstream_unreachable" }, { status: 502 })),
    );
    render(<AccessToken r={REPO} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project access token"), { target: { value: "x" } });
    await press("Save");
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not save the token: GitLab did not answer; try again.",
    );
  });

  it("words a job GitLab refused the token of", () => {
    expect(jobError("token_rejected")).toBe("GitLab refused this project's access token");
  });
});
