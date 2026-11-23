import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { AutoEnroll, GroupEnroll } from "./auto-enroll.js";
import { BulkEnroll } from "./bulk-enroll.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const listed = (n: number) => ({
  platforms: [
    {
      platform: "github" as const,
      repositories: Array.from({ length: n }, (_, i) => ({ fullName: `acme/r${i + 1}` })),
    },
  ],
});
const projects = {
  platforms: [
    {
      platform: "gitlab" as const,
      repositories: Array.from({ length: 12 }, (_, i) => ({ fullName: `pay/sub/p${i + 1}` })),
    },
  ],
};
const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("adding several repositories", () => {
  it("is not offered for a single repository left to add", () => {
    render(<BulkEnroll platform="github" listed={listed(1)} enrolled={[]} onAdded={() => {}} />);
    expect(screen.queryByRole("form", { name: "Add several from GitHub" })).toBeNull();
  });

  it("sends a large choice in parts and says what became of each repository", async () => {
    const sent: { fullNames: string[]; automatic: boolean }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sent.push(body);
        return Response.json({
          results: body.fullNames.map((fullName: string) =>
            fullName === "acme/r2"
              ? { fullName, outcome: "refused", reason: "taken" }
              : { fullName, outcome: fullName === "acme/r3" ? "already" : "enrolled", repo: {} },
          ),
        });
      }),
    );
    const added = vi.fn();
    render(<BulkEnroll platform="github" listed={listed(23)} enrolled={[]} onAdded={added} />);
    await press("Choose");
    await press("Select all");
    fireEvent.click(screen.getByLabelText(/Review each pull request as it opens/));
    await press("Add 23 repositories");
    expect(sent.map((s) => s.fullNames.length)).toEqual([20, 3]);
    expect(sent.every((s) => s.automatic)).toBe(true);
    const said = screen.getByRole("status").textContent;
    expect(said).toContain("Added 21 repositories; 1 already under review; 1 not added.");
    expect(said).toContain("acme/r2: another account reviews it");
    expect(added).toHaveBeenCalledOnce();
  });

  it("shows what was added before a later part failed", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 2) return Response.json({ error: "github_user" }, { status: 502 });
        const { fullNames } = JSON.parse(String(init?.body));
        return Response.json({
          results: fullNames.map((fullName: string) => ({
            fullName,
            outcome: "enrolled",
            repo: {},
          })),
        });
      }),
    );
    render(<BulkEnroll platform="github" listed={listed(21)} enrolled={[]} onAdded={() => {}} />);
    await press("Choose");
    await press("Select all");
    await press("Add 21 repositories");
    expect(screen.getByRole("status").textContent).toContain("Added 20 repositories.");
    expect(screen.getByRole("alert").textContent).toMatch(/^Could not add the rest: /);
  });
});

describe("adding several GitLab projects", () => {
  it("sends them ten at a time as GitLab's, and shows once the secret of a hook to add by hand", async () => {
    const sent: { platform: string; fullNames: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sent.push(body);
        return Response.json({
          results: body.fullNames.map((fullName: string) => ({
            fullName,
            outcome: "enrolled",
            repo: {},
            webhook:
              fullName === "pay/sub/p2"
                ? {
                    url: "https://ocra.example.com/api/auto-review/webhooks/gitlab",
                    secret: "ocra_hook_p2",
                    managed: false,
                    problem: "the token may not add webhooks",
                  }
                : {
                    url: "https://ocra.example.com/api/auto-review/webhooks/gitlab",
                    managed: true,
                  },
          })),
        });
      }),
    );
    render(<BulkEnroll platform="gitlab" listed={projects} enrolled={[]} onAdded={() => {}} />);
    expect(screen.getByRole("form", { name: "Add several from GitLab" }).textContent).toContain(
      "12 projects you reach on GitLab are not under review.",
    );
    await press("Choose");
    await press("Select all");
    expect(screen.getByLabelText(/Review each merge request as it opens/)).toBeTruthy();
    await press("Add 12 projects");
    expect(sent.map((s) => [s.platform, s.fullNames.length])).toEqual([
      ["gitlab", 10],
      ["gitlab", 2],
    ]);
    const byHand = screen.getByRole("region", { name: "Webhooks to add by hand" });
    expect(byHand.textContent).toContain("could not add the webhook of 1 project itself");
    expect(byHand.textContent).toContain("pay/sub/p2: the token may not add webhooks");
    expect(byHand.textContent).toContain("ocra_hook_p2");
    expect(byHand.textContent).not.toContain("pay/sub/p1:");
  });
});

describe("enrolling a GitLab group's new projects", () => {
  it("reads the groups, switches one on at its own address and words it for projects", async () => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method !== "PUT") {
          return Response.json({
            groups: [{ id: "42", fullPath: "pay/sub", enabled: false, automatic: false }],
            more: true,
          });
        }
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: "42", fullPath: "pay/sub", enabled: true, automatic: false });
      }),
    );
    render(<GroupEnroll />);
    const toggle = await screen.findByRole("switch", { name: "Enroll new projects of pay/sub" });
    await act(async () => void fireEvent.click(toggle));
    expect(sent).toEqual([
      {
        url: "/api/auto-review/gitlab/groups/42/auto-enroll",
        body: { enabled: true, automatic: false },
      },
    ]);
    expect(screen.getByLabelText(/Also review each merge request/)).toBeTruthy();
    const card = screen.getByRole("region", { name: "New GitLab projects" });
    expect(card.textContent).toContain("looks once a day");
    expect(card.textContent).toContain("GitLab lists more groups than are shown here.");
  });

  it("shows nothing when the account has no GitLab link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "github_user" }, { status: 400 })),
    );
    const { container } = render(<GroupEnroll />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});

describe("enrolling an installation's new repositories", () => {
  const stub = (put: () => Response) => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== "PUT") {
          return Response.json({
            installations: [{ id: "7", owner: "acme", enabled: false, automatic: false }],
            more: false,
          });
        }
        sent.push(JSON.parse(String(init.body)));
        return put();
      }),
    );
    return sent;
  };

  it("switches it on, then offers to review them automatically", async () => {
    const sent = stub(() =>
      Response.json({ id: "7", owner: "acme", enabled: true, automatic: false }),
    );
    render(<AutoEnroll />);
    const toggle = await screen.findByRole("switch", { name: "Enroll new repositories of acme" });
    expect(screen.queryByLabelText(/Also review/)).toBeNull();
    await act(async () => void fireEvent.click(toggle));
    expect(sent).toEqual([{ enabled: true, automatic: false }]);
    expect(screen.getByLabelText(/Also review each pull request/)).toBeTruthy();
  });

  it("says another account enrolls them, and stays off", async () => {
    stub(() =>
      Response.json(
        {
          error: "invalid_body",
          issues: [
            {
              path: ["enabled"],
              message: "another account enrolls this installation's repositories",
            },
          ],
        },
        { status: 400 },
      ),
    );
    render(<AutoEnroll />);
    const toggle = await screen.findByRole("switch", { name: "Enroll new repositories of acme" });
    await act(async () => void fireEvent.click(toggle));
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not change it: another account enrolls this installation's repositories.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
