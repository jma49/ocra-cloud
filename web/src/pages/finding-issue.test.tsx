import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FindingIssueAnswer, FindingIssueDraftView } from "../../../src/shared/index.js";
import { FindingIssue } from "./finding-issue.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const issue = { number: 41, url: "https://github.com/octo/api/issues/41" };

function serve(view: FindingIssueDraftView, answer: FindingIssueAnswer) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json(answer);
      }
      return Response.json(view);
    }),
  );
  return sent;
}

const draft: FindingIssueDraftView = {
  platform: "github",
  repo: "octo/api",
  title: "Critical: SQL built from input",
  body: "Found by ocra.",
  issue: null,
};

const inDrawer = () => within(screen.getByRole("dialog", { name: "New issue" }));

describe("opening an issue from a finding", () => {
  it("drafts on a click, opens the edited issue, then links it", async () => {
    const sent = serve(draft, { outcome: "done", issue, created: true });
    render(<FindingIssue findingId="f1" issue={null} />);
    await act(async () => void fireEvent.click(screen.getByText("Open issue")));
    const title = (await screen.findByLabelText("Issue title")) as HTMLInputElement;
    expect(title.value).toBe(draft.title);
    expect(screen.getByText("New issue in octo/api")).toBeTruthy();
    fireEvent.change(title, { target: { value: "Edited" } });
    await act(
      async () => void fireEvent.click(inDrawer().getByRole("button", { name: "Open issue" })),
    );
    expect(sent).toEqual([
      { url: "/api/findings/f1/issue", body: { title: "Edited", body: "Found by ocra." } },
    ]);
    const link = screen.getByText("Issue #41") as HTMLAnchorElement;
    expect(link.href).toBe(issue.url);
  });

  it("links an issue already opened instead of offering another", () => {
    serve(draft, { outcome: "refused" });
    render(<FindingIssue findingId="f1" issue={issue} />);
    expect(screen.getByText("Issue #41")).toBeTruthy();
    expect(screen.queryByText("Open issue")).toBeNull();
  });

  it("says when the platform refused", async () => {
    serve(draft, { outcome: "refused" });
    render(<FindingIssue findingId="f1" issue={null} />);
    await act(async () => void fireEvent.click(screen.getByText("Open issue")));
    await screen.findByLabelText("Issue title");
    await act(
      async () => void fireEvent.click(inDrawer().getByRole("button", { name: "Open issue" })),
    );
    expect(screen.getByText("The platform refused to open the issue.")).toBeTruthy();
  });

  it("keeps the edited draft when the drawer closes, without drafting again", async () => {
    serve(draft, { outcome: "refused" });
    render(<FindingIssue findingId="f1" issue={null} />);
    await act(async () => void fireEvent.click(screen.getByText("Open issue")));
    fireEvent.change(await screen.findByLabelText("Issue title"), { target: { value: "Mine" } });
    fireEvent.click(inDrawer().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Open issue"));
    expect((screen.getByLabelText("Issue title") as HTMLInputElement).value).toBe("Mine");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
