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
const reviewed: PullDescriptionDraftView = {
  head: HEAD,
  body: "<!-- ocra:description:start -->\nMine, with `code`.",
  draft: "Mine.\n\nocra's part",
  review: {
    id: "r1",
    head: HEAD,
    current: true,
    complete: true,
    createdAt: new Date().toISOString(),
  },
};

function saves() {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ outcome: "done" });
    }),
  );
  return sent;
}

const edit = () => screen.getByLabelText("Pull request description") as HTMLTextAreaElement;

describe("the description on a pull request", () => {
  it("shows the description as it is, without the markers in it", () => {
    render(<DescriptionBox pull={pull} view={reviewed} editable onDone={() => undefined} />);
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.queryByText(/ocra:description/)).toBeNull();
    cleanup();
    render(
      <DescriptionBox
        pull={pull}
        view={{ ...reviewed, body: "", draft: null, review: null }}
        editable={false}
        onDone={() => undefined}
      />,
    );
    expect(screen.getByText("No description yet.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens ocra's draft, and saves the edited text on the head it was read at", async () => {
    const sent = saves();
    const done = vi.fn();
    render(<DescriptionBox pull={pull} view={reviewed} editable onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft with ocra" }));
    expect(edit().value).toBe("Mine.\n\nocra's part");
    expect(screen.getByText(/the current head/)).toBeTruthy();
    fireEvent.change(edit(), { target: { value: "Edited." } });
    await act(async () => void fireEvent.click(screen.getByText("Save description")));
    expect(sent).toEqual([{ ...pull, head: HEAD, body: "Edited." }]);
    expect(done).toHaveBeenCalledWith("done");
    expect(screen.queryByLabelText("Pull request description")).toBeNull();
    expect(screen.getByRole("button", { name: "Draft with ocra" })).toBeTruthy();
  });

  it("keeps an unsaved draft when the drawer closes, and starts over on request", () => {
    const earlier = { ...reviewed.review, head: "b".repeat(40), current: false };
    render(
      <DescriptionBox
        pull={pull}
        view={{ ...reviewed, review: earlier as PullDescriptionDraftView["review"] }}
        editable
        onDone={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft with ocra" }));
    expect(screen.getByText(/an earlier head/)).toBeTruthy();
    expect(screen.queryByText("Start over")).toBeNull();
    fireEvent.change(edit(), { target: { value: "Half done" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Pull request description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(edit().value).toBe("Half done");
    fireEvent.click(screen.getByText("Start over"));
    expect(edit().value).toBe("Mine.\n\nocra's part");
  });

  it("says when ocra has not reviewed the pull request", () => {
    render(
      <DescriptionBox
        pull={pull}
        view={{ head: HEAD, body: "Mine.", draft: null, review: null }}
        editable
        onDone={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText(/has not reviewed this pull request yet/)).toBeTruthy();
    expect(edit().value).toBe("Mine.");
  });
});
