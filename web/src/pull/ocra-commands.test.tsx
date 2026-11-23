import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullCommandsView } from "../../../src/shared/index.js";
import { OcraCommands } from "./ocra-commands.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "github", repo: "Octo/API", number: 7 };
const AT = "/api/auto-review/repos/r1/pulls/7";

/** Serves the enrolled repositories and the pull request's commands; a pause change answers `refuse` when set. */
function serve(view: PullCommandsView, repo: { automatic: boolean } | null, refuse = false) {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auto-review/repos")
        return Response.json({
          repos: repo ? [{ id: "r1", platform: "github", fullName: "octo/api", ...repo }] : [],
        });
      if (url === `${AT}/commands`) return Response.json(view);
      if (url === `${AT}/pause`) {
        sent.push(String(init?.method));
        if (refuse) return Response.json({ error: "rate_limited" }, { status: 429 });
        return Response.json({ paused: init?.method === "PUT" });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return sent;
}

const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("the pull request's @ocra commands", () => {
  it("shows nothing for a repository this account has not enrolled", async () => {
    serve({ paused: false, commands: [] }, null);
    const { container } = render(<OcraCommands pull={pull} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("pauses and resumes the automatic reviews, as the server answers", async () => {
    const sent = serve({ paused: false, commands: [] }, { automatic: true });
    render(<OcraCommands pull={pull} />);
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByText("Paused")).toBeNull();
    await press("Pause");
    expect(screen.getByText("Paused")).toBeTruthy();
    await press("Resume");
    expect(screen.queryByText("Paused")).toBeNull();
    expect(sent).toEqual(["PUT", "DELETE"]);
  });

  it("offers no pause where reviews start only when asked, but lets a paused one resume", async () => {
    serve({ paused: false, commands: [] }, { automatic: false });
    const { container, unmount } = render(<OcraCommands pull={pull} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
    unmount();
    serve({ paused: true, commands: [] }, { automatic: false });
    render(<OcraCommands pull={pull} />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("keeps the state it had when the change is refused, and says so", async () => {
    serve({ paused: false, commands: [] }, { automatic: true }, true);
    render(<OcraCommands pull={pull} />);
    await screen.findByRole("button", { name: "Pause" });
    await press("Pause");
    expect(screen.getByRole("alert").textContent).toContain("Could not pause it");
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("lists the commands with how each ended", async () => {
    const at = new Date().toISOString();
    serve(
      {
        paused: false,
        commands: [
          { command: "generate_tests", outcome: "refused", createdAt: at, finishedAt: at },
          { command: "review", outcome: "done", createdAt: at, finishedAt: at },
        ],
      },
      { automatic: false },
    );
    render(<OcraCommands pull={pull} />);
    const head = await screen.findByText("Commands from comments (2)");
    const rows = [...(head.closest("details")?.querySelectorAll("li") ?? [])].map(
      (li) => li.textContent,
    );
    expect(rows[0]).toContain("@ocra generate tests");
    expect(rows[0]).toContain("Refused");
    expect(rows[1]).toContain("@ocra review");
    expect(rows[1]).toContain("Done");
    expect(head.closest("details")?.textContent).toContain("may not push to the repository");
  });
});
