import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldReleaseDraftView } from "../../../src/shared/index.js";
import { HeldDrafts } from "./held-drafts.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draft: HeldReleaseDraftView = {
  id: "d1",
  tag: "v1.5.0",
  target: "main",
  name: "Refunds",
  body: "## What changed",
  version: 3,
  updatedAt: new Date().toISOString(),
};

/** Answers a publish with `answer` and a discard with nothing, and keeps what was asked. */
function serve(answer: unknown) {
  const asked: { url: string; method?: string | undefined; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(init?.method === "DELETE" ? {} : answer);
    }),
  );
  return asked;
}

const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("the drafts held for a platform without draft releases", () => {
  it("names each by its tag and where the tag will be made", () => {
    serve({});
    render(
      <HeldDrafts
        drafts={[draft, { ...draft, id: "d2", tag: "v1.6.0", name: "v1.6.0" }]}
        gone={() => {}}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("v1.5.0 Refunds");
    expect(rows[0]?.textContent).toContain("Tag made at main when published");
    expect(rows[1]?.textContent).not.toContain("v1.6.0 v1.6.0");
  });

  it("publishes the version it shows, and then links the release", async () => {
    const asked = serve({ outcome: "published", url: "https://gitlab.example.com/r/v1.5.0" });
    render(<HeldDrafts drafts={[draft]} gone={() => {}} />);
    await press("Publish v1.5.0");
    expect(asked).toEqual([
      { url: "/api/release-notes/held/d1/publish", method: "POST", body: { version: 3 } },
    ]);
    const link = screen.getByRole("link", { name: "Open the release" });
    expect(link.getAttribute("href")).toBe("https://gitlab.example.com/r/v1.5.0");
    expect(screen.queryByRole("button", { name: "Publish v1.5.0" })).toBeNull();
    expect(screen.getByRole("listitem").textContent).toContain("Published main");
  });

  it("keeps the draft and says why when the platform does not take it", async () => {
    serve({ outcome: "tag_exists" });
    render(<HeldDrafts drafts={[draft]} gone={() => {}} />);
    await press("Publish v1.5.0");
    expect(screen.getByRole("alert").textContent).toBe(
      "That tag, or a release of it, already exists.",
    );
    expect(screen.getByRole("button", { name: "Publish v1.5.0" })).toBeTruthy();
  });

  it("discards the version it shows", async () => {
    const asked = serve({});
    const gone = vi.fn();
    render(<HeldDrafts drafts={[draft]} gone={gone} />);
    await press("Discard the draft of v1.5.0");
    expect(asked).toEqual([{ url: "/api/release-notes/held/d1?version=3", method: "DELETE" }]);
    expect(gone).toHaveBeenCalledWith("d1");
  });
});
