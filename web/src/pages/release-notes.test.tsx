import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReleaseNotesView,
  ReleasePublishAnswer,
  ReleasePullView,
} from "../../../src/shared/index.js";
import { nextTag } from "../release-notes/publish.js";
import { ReleaseNotes } from "./ReleaseNotes.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = (number: number, title: string, more: Partial<ReleasePullView>): ReleasePullView => ({
  number,
  title,
  url: `https://github.com/acme/payments/pull/${number}`,
  author: "ada",
  mergedAt: "2026-11-20T10:00:00Z",
  type: "feat",
  breaking: false,
  section: "added",
  review: null,
  ...more,
});
const notes = (more: Partial<ReleaseNotesView> = {}): ReleaseNotesView => ({
  platform: "github",
  repo: "acme/payments",
  from: "v1.4.0",
  to: "main",
  pulls: [
    pull(482, "feat: refunds by line item", {
      review: { verdict: "minor_issues", findings: 2 },
    }),
    pull(480, "fix: round half up", { section: "fixed", type: "fix" }),
    pull(479, "chore: bump deps", { section: "hidden", type: "chore" }),
  ],
  truncated: false,
  body: "## Added\n- refunds by line item (#482)\n",
  drafts: true,
  ...more,
});

function serve(view: ReleaseNotesView | 404, answers: ReleasePublishAnswer[] = []) {
  const sent: { url: string; body?: unknown }[] = [];
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/platforms/repos")
        return Response.json({
          platforms: [
            { platform: "github", linked: true, repositories: [{ fullName: "acme/payments" }] },
            { platform: "gitlab", linked: false, repositories: [{ fullName: "acme/old" }] },
          ],
        });
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (init?.method === "POST") return Response.json(answers.shift());
      return view === 404
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json(view);
    }),
  );
  return { sent, writeText };
}

async function draft() {
  render(<ReleaseNotes />);
  const form = within(await screen.findByRole("form", { name: "Range" }));
  fireEvent.change(form.getByLabelText("Repository"), {
    target: { value: "github|acme/payments" },
  });
  fireEvent.change(form.getByLabelText("From"), { target: { value: "v1.4.0" } });
  await act(async () => void fireEvent.click(form.getByRole("button", { name: "Draft notes" })));
  return form;
}

describe("the Release notes page", () => {
  it("offers only a connected platform's repositories, and drafts a range by section", async () => {
    const { sent } = serve(notes());
    const form = await draft();
    expect(form.queryByRole("option", { name: "acme/old" })).toBeNull();
    expect(sent[0]?.url).toBe(
      "/api/release-notes?platform=github&repo=acme%2Fpayments&from=v1.4.0&to=main&hidden=false&reviews=false",
    );
    const list = within(screen.getByRole("region", { name: "Pull requests in the range" }));
    const added = within(list.getByRole("region", { name: "Added" }));
    expect(added.getByRole("link", { name: "#482" }).getAttribute("href")).toMatch(/pull\/482$/);
    expect(added.getByText("Minor issues")).toBeTruthy();
    expect(list.getByRole("region", { name: "Fixed" })).toBeTruthy();
    expect(list.queryByRole("region", { name: "Maintenance" })).toBeNull();
    expect(list.getByText(/1 maintenance change is left out/)).toBeTruthy();
  });

  it("says when a range does not exist", async () => {
    serve(404);
    const form = await draft();
    expect(form.getByRole("alert").textContent).toMatch(
      /No such repository, tag, branch or commit/,
    );
  });

  it("copies the edited notes, goes back to the draft, and saves the edit as a draft release", async () => {
    const { sent, writeText } = serve(notes(), [
      { outcome: "tag_exists" },
      {
        outcome: "created",
        release: { id: 7, url: "https://github.com/acme/payments/releases/7" },
      },
    ]);
    await draft();
    const box = within(screen.getByRole("region", { name: "Notes" }));
    const text = box.getByLabelText("Release notes in Markdown");
    fireEvent.change(text, { target: { value: "## Added\n- refunds\n" } });
    await act(async () => void fireEvent.click(box.getByRole("button", { name: "Copy Markdown" })));
    expect(writeText).toHaveBeenCalledWith("## Added\n- refunds\n");

    const save = within(screen.getByRole("form", { name: "Save a draft release" }));
    expect((save.getByLabelText("Target") as HTMLInputElement).value).toBe("main");
    fireEvent.change(save.getByLabelText("Tag"), { target: { value: "v1.4.0" } });
    await act(
      async () => void fireEvent.click(save.getByRole("button", { name: "Save draft release" })),
    );
    expect(sent.at(-1)).toEqual({
      url: "/api/release-notes/publish",
      body: {
        platform: "github",
        repo: "acme/payments",
        tag: "v1.4.0",
        target: "main",
        name: "v1.4.0",
        body: "## Added\n- refunds\n",
        draft: true,
      },
    });
    expect(save.getByRole("alert").textContent).toMatch(/already exists/);
    fireEvent.click(save.getByRole("button", { name: "Use v1.4.1" }));
    await act(
      async () => void fireEvent.click(save.getByRole("button", { name: "Save draft release" })),
    );
    expect(save.getByRole("link", { name: "Open it on the platform" }).getAttribute("href")).toBe(
      "https://github.com/acme/payments/releases/7",
    );

    fireEvent.click(box.getByRole("button", { name: "Back to the draft" }));
    expect((text as HTMLTextAreaElement).value).toBe(notes().body);
  });

  it("offers only the Markdown where the platform keeps no draft releases", async () => {
    serve(notes({ drafts: false }));
    await draft();
    expect(screen.queryByRole("form", { name: "Save a draft release" })).toBeNull();
    expect(screen.getByText(/keeps no draft releases/)).toBeTruthy();
  });

  it("suggests the tag after one that exists", () => {
    expect(nextTag("v1.4.9")).toBe("v1.4.10");
    expect(nextTag("2026.11-rc1")).toBe("2026.11-rc2");
    expect(nextTag("stable")).toBeNull();
  });
});
