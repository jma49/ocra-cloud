import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullPeopleView } from "../../../src/shared/index.js";
import { PeopleCard, usePullPeople } from "./people.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "github", repo: "octo/api", number: 7 } as const;
const view: PullPeopleView = {
  ...pull,
  author: "sample-user",
  reviewers: [
    { login: "lead", state: "requested" },
    { login: "dba", state: "approved" },
  ],
  teams: [{ slug: "core", name: "octo/core" }],
  assignees: ["sample-user"],
  truncated: false,
};

function Card(props: { editable: boolean }) {
  const read = usePullPeople(pull);
  return <PeopleCard pull={pull} read={read} editable={props.editable} />;
}

function show(outcome = "done", editable = true) {
  const sent: { path: string; body: unknown }[] = [];
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const at = new URL(url, "http://x");
      if (init?.method === "POST") {
        sent.push({ path: at.pathname, body: JSON.parse(String(init.body)) });
        return Response.json({ outcome });
      }
      if (at.pathname.endsWith("/candidates")) {
        asked.push(at.searchParams.get("prefix") ?? "");
        return Response.json({
          candidates: [
            { login: "lead", name: "Lena Ortiz" },
            { login: "leo", name: null },
          ],
          truncated: false,
        });
      }
      return Response.json(view);
    }),
  );
  render(<Card editable={editable} />);
  return { sent, asked };
}

describe("a pull request's reviewers and assignees", () => {
  it("says where each reviewer stands, and takes off only one still asked", async () => {
    const { sent } = show();
    const card = await screen.findByRole("region", { name: "Reviewers and assignees" });
    expect(within(card).getByText("Asked")).toBeTruthy();
    expect(within(card).getByText("Approved")).toBeTruthy();
    expect(within(card).getByText("Team asked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop asking dba" })).toBeNull();
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Stop asking lead" })),
    );
    expect(sent).toEqual([
      { path: "/api/pulls/people/reviewers", body: { ...pull, add: [], remove: ["lead"] } },
    ]);
  });

  it("finds the repository's people by prefix, leaves out those already there, and adds one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { sent, asked } = show();
      fireEvent.click(await screen.findByRole("button", { name: "Add reviewer" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Add reviewer" }), {
        target: { value: "le" },
      });
      await act(async () => void vi.advanceTimersByTime(300));
      const option = await screen.findByRole("button", { name: "leo" });
      expect(asked).toEqual(["le"]);
      expect(screen.queryByRole("button", { name: /Lena Ortiz/ })).toBeNull();
      await act(async () => void fireEvent.click(option));
      expect(sent).toEqual([
        { path: "/api/pulls/people/reviewers", body: { ...pull, add: ["leo"], remove: [] } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unassigns, and says so when the platform refuses", async () => {
    const { sent } = show("refused");
    const off = await screen.findByRole("button", { name: "Unassign sample-user" });
    await act(async () => void fireEvent.click(off));
    expect(sent[0]?.path).toBe("/api/pulls/people/assignees");
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("closes the search on Escape without changing anything", async () => {
    const { sent } = show();
    fireEvent.click(await screen.findByRole("button", { name: "Add assignee" }));
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Add assignee" }), { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("offers no change on a pull request that is settled", async () => {
    show("done", false);
    await screen.findByText("Asked");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
