import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { AutoEnroll } from "./auto-enroll.js";
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
const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("adding several repositories", () => {
  it("is not offered for a single repository left to add", () => {
    render(<BulkEnroll listed={listed(1)} enrolled={[]} onAdded={() => {}} />);
    expect(screen.queryByLabelText("Add several")).toBeNull();
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
    render(<BulkEnroll listed={listed(23)} enrolled={[]} onAdded={added} />);
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
    render(<BulkEnroll listed={listed(21)} enrolled={[]} onAdded={() => {}} />);
    await press("Choose");
    await press("Select all");
    await press("Add 21 repositories");
    expect(screen.getByRole("status").textContent).toContain("Added 20 repositories.");
    expect(screen.getByRole("alert").textContent).toMatch(/^Could not add the rest: /);
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
