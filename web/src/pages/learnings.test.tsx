import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idFrom } from "../learnings/learning-form.js";
import { Learnings } from "./Learnings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

const BLOB = "a".repeat(40);
const learning = {
  id: "refund-cap",
  path: ".ocra/learnings/refund-cap.md",
  blobId: BLOB,
  title: "Refunds never exceed what was captured",
  body: "Check `amount` against `charge.captured - charge.refunded`.",
  paths: ["src/refunds/**"],
  symbols: ["refundPartial"],
  keywords: [],
  critical: true,
  source: { kind: "fix-commit", ref: "9f2c1e4" },
  created: "2026-11-01",
  lastCommit: null,
};

function serve(answer: { outcome: string; pull: unknown }) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ path: learning.path, ...answer });
      }
      if (url === "/api/platforms/repos")
        return Response.json({
          platforms: [
            { platform: "github", repositories: [{ id: "1", fullName: "acme/payments" }] },
          ],
        });
      if (url.startsWith("/api/learnings/proposals"))
        return Response.json({
          more: false,
          proposals: [
            {
              number: 7,
              title: "chore(ocra): propose learnings",
              url: "https://github.com/acme/payments/pull/7",
              branch: "ocra/learnings-1",
              head: "b".repeat(40),
              author: "ada",
              createdAt: "2026-11-21T10:00:00Z",
              learnings: [{ ...learning, id: "ledger-order", title: "Post to the ledger last" }],
              invalid: [],
              removed: ["old-rule"],
            },
          ],
        });
      return Response.json({
        platform: "github",
        repo: "acme/payments",
        branch: "main",
        commit: "c".repeat(40),
        learnings: [learning],
        invalid: [
          {
            path: ".ocra/learnings/Bad Name.md",
            blobId: BLOB,
            reason: "its name is not a learning's",
          },
        ],
        total: 2,
        usage: { "refund-cap": { reviews: 4, lastUsedAt: new Date().toISOString() } },
        usageDays: 90,
        next: null,
      });
    }),
  );
  return sent;
}

describe("the Learnings page", () => {
  it("reads the first repository's learnings, the files reviews skip, and open proposals", async () => {
    serve({ outcome: "done", pull: null });
    render(<Learnings />);
    expect(await screen.findByText("Refunds never exceed what was captured")).toBeTruthy();
    expect(screen.getByText(/used in 4 reviews, last just now/)).toBeTruthy();
    expect(screen.getByText(/is skipped by reviews: its name is not a learning's/)).toBeTruthy();
    expect(await screen.findByText("#7 chore(ocra): propose learnings")).toBeTruthy();
    expect(screen.getByText("Post to the ledger last")).toBeTruthy();
    expect(screen.getByText("old-rule")).toBeTruthy();
  });

  it("opens a learning from a button that holds no other control", async () => {
    serve({ outcome: "done", pull: null });
    render(<Learnings />);
    await screen.findByText("Refunds never exceed what was captured");
    const toggle = screen.getByRole("button", { name: /^Refunds never exceed what was captured/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(toggle).queryAllByRole("button")).toEqual([]);
    expect(toggle.contains(screen.getByRole("button", { name: "Edit" }))).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")?.hidden).toBe(false);
  });

  it("sends an edit on the blob it read, and says which pull request it opened", async () => {
    const sent = serve({
      outcome: "done",
      pull: { number: 9, url: "https://github.com/acme/payments/pull/9" },
    });
    render(<Learnings />);
    await screen.findByText("Refunds never exceed what was captured");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: `Edit ${learning.title}` });
    fireEvent.change(within(form).getByLabelText("Keywords"), { target: { value: "chargeback" } });
    await act(
      async () =>
        void fireEvent.click(within(form).getByRole("button", { name: "Open pull request" })),
    );
    expect(sent[0]).toEqual({
      url: "/api/learnings",
      body: {
        platform: "github",
        repo: "acme/payments",
        id: "refund-cap",
        direct: false,
        expected: BLOB,
        learning: {
          title: learning.title,
          paths: ["src/refunds/**"],
          symbols: ["refundPartial"],
          keywords: ["chargeback"],
          critical: true,
          source: { kind: "fix-commit", ref: "9f2c1e4" },
          created: "2026-11-01",
          body: learning.body,
        },
      },
    });
    await waitFor(() => expect(screen.getByRole("link", { name: "pull request #9" })).toBeTruthy());
  });

  it("says when the file changed since it was read", async () => {
    serve({ outcome: "conflict", pull: null });
    render(<Learnings />);
    await screen.findByText("Refunds never exceed what was captured");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(screen.getByText(/changed since this page read it/)).toBeTruthy();
  });

  it("names a new learning's file after its title", () => {
    expect(idFrom("Refunds never exceed: what was captured!")).toBe(
      "refunds-never-exceed-what-was-captured",
    );
  });
});
