import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullDescriptionDraftView } from "../../../src/shared/index.js";
import { DescriptionBox } from "./description-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };

function serve(view: PullDescriptionDraftView) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({ outcome: "done" });
      }
      return Response.json(view);
    }),
  );
  return sent;
}

describe("the description card on a pull request", () => {
  it("drafts on a click, and saves the edited text on the head it drafted on", async () => {
    const sent = serve({
      head: HEAD,
      body: "Mine.",
      draft: "Mine.\n\nocra's part",
      review: { id: "r1", head: HEAD, current: true, createdAt: new Date().toISOString() },
    });
    const done = vi.fn();
    render(<DescriptionBox pull={pull} onDone={done} />);
    await act(async () => void fireEvent.click(screen.getByText("Write the PR description")));
    const box = (await screen.findByLabelText("Pull request description")) as HTMLTextAreaElement;
    expect(box.value).toBe("Mine.\n\nocra's part");
    expect(screen.getByText(/the current head/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "Edited." } });
    await act(async () => void fireEvent.click(screen.getByText("Save description")));
    expect(sent).toEqual([{ ...pull, head: HEAD, body: "Edited." }]);
    expect(done).toHaveBeenCalledWith("done");
    expect(screen.queryByLabelText("Pull request description")).toBeNull();
    expect(screen.getByText("Write the PR description")).toBeTruthy();
  });

  it("keeps an unsaved draft when the drawer closes, and starts over on request", async () => {
    serve({
      head: HEAD,
      body: "Mine.",
      draft: "Mine.\n\nocra's part",
      review: { id: "r1", head: "b".repeat(40), current: false, createdAt: "2026-11-22T10:00:00Z" },
    });
    render(<DescriptionBox pull={pull} onDone={() => undefined} />);
    await act(async () => void fireEvent.click(screen.getByText("Write the PR description")));
    expect(screen.getByText(/an earlier head/)).toBeTruthy();
    const edit = () => screen.getByLabelText("Pull request description") as HTMLTextAreaElement;
    expect(screen.queryByText("Start over")).toBeNull();
    fireEvent.change(edit(), { target: { value: "Half done" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Pull request description")).toBeNull();
    fireEvent.click(screen.getByText("Continue the description"));
    expect(edit().value).toBe("Half done");
    fireEvent.click(screen.getByText("Start over"));
    expect(edit().value).toBe("Mine.\n\nocra's part");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.getByText("Write the PR description")).toBeTruthy();
  });

  it("says when ocra has not reviewed the pull request", async () => {
    serve({ head: HEAD, body: "Mine.", draft: null, review: null });
    render(<DescriptionBox pull={pull} onDone={() => undefined} />);
    await act(async () => void fireEvent.click(screen.getByText("Write the PR description")));
    expect(await screen.findByText(/has not reviewed this pull request yet/)).toBeTruthy();
  });
});
