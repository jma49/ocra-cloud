import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullThreadsView, ReviewThreadView } from "../../../src/shared/index.js";
import { ToastProvider } from "../toast.js";
import { ThreadsPanel } from "./threads.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const thread = (id: string, path: string, over: Partial<ReviewThreadView> = {}) =>
  ({
    id,
    path,
    line: 11,
    startLine: null,
    side: "new",
    resolved: false,
    outdated: false,
    canResolve: true,
    comments: [
      {
        id: `${id}c`,
        author: "rev",
        body: `Note on ${id}`,
        createdAt: null,
        suggestions: [
          {
            id: `${id}:0`,
            startLine: 10,
            endLine: 11,
            replacement: `fix ${id}`,
            applicable: true,
            applied: false,
          },
        ],
      },
    ],
    ...over,
  }) satisfies ReviewThreadView;

const show = async (platform: string, threads: ReviewThreadView[]) => {
  const view: PullThreadsView = { head: "abc", truncated: false, threads };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(view)),
  );
  render(<ThreadsPanel pull={{ platform, repo: "octo/api", number: 7 }} onDone={() => {}} />);
  await screen.findByRole("region", { name: "Review threads" });
};

/** The panel with toasts, where each write waits until the test answers it. */
const writes = async (threads: ReviewThreadView[]) => {
  const view: PullThreadsView = { head: "abc", truncated: false, threads };
  const sent: { url: string; body: Record<string, unknown>; answer: (o: string) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json(view);
      return new Promise<Response>((done) =>
        sent.push({
          url,
          body: JSON.parse(String(init.body)),
          answer: (outcome) => done(Response.json({ outcome })),
        }),
      );
    }),
  );
  render(
    <ToastProvider>
      <ThreadsPanel pull={{ platform: "github", repo: "octo/api", number: 7 }} onDone={() => {}} />
    </ToastProvider>,
  );
  await screen.findByRole("region", { name: "Review threads" });
  return sent;
};
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("the review threads panel", () => {
  it("lets GitHub suggestions be picked together only within one file", async () => {
    await show("github", [
      thread("A", "src/a.ts"),
      thread("B", "src/a.ts", { line: 20 }),
      thread("C", "src/b.ts"),
    ]);
    const [a, b, c] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(a as HTMLElement);
    expect([a?.disabled, b?.disabled, c?.disabled]).toEqual([false, false, true]);
    fireEvent.click(a as HTMLElement);
    expect(c?.disabled).toBe(false);
  });

  it("leaves GitLab suggestions in several files free to pick", async () => {
    await show("gitlab", [thread("A", "src/a.ts"), thread("C", "src/b.ts")]);
    const [a, c] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(a as HTMLElement);
    expect(c?.disabled).toBe(false);
    fireEvent.click(c as HTMLElement);
    expect(screen.getByRole("button", { name: "Commit 2 suggestions" })).toBeTruthy();
  });

  it("names the lines a suggestion replaces, counts the threads and offers no commit for resolved ones", async () => {
    await show("github", [thread("A", "src/a.ts")]);
    expect(box("Apply to lines 10–11")).toBeTruthy();
    expect(screen.getByText("1 open")).toBeTruthy();
    cleanup();
    await show("github", [thread("R", "src/a.ts", { resolved: true })]);
    expect(screen.getByText("1 resolved")).toBeTruthy();
    expect(screen.getByText("1 comment")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Commit/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("resolves at once, offers Undo, and sends the reopen when it is pressed", async () => {
    const sent = await writes([thread("A", "src/a.ts")]);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.getByText("1 resolved")).toBeTruthy();
    expect(sent[0]?.body).toMatchObject({ thread: "A", resolved: true });
    await act(async () => sent[0]?.answer("done"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sent[1]?.body).toMatchObject({ thread: "A", resolved: false }));
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("takes a resolve back and says why when the platform refuses it", async () => {
    const sent = await writes([thread("A", "src/a.ts")]);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await act(async () => sent[0]?.answer("refused"));
    expect(await screen.findByText(/The platform refused it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.getByText("1 open")).toBeTruthy();
  });

  it("shows a reply the moment Mod+Enter sends it, and gives the words back if refused", async () => {
    const sent = await writes([thread("A", "src/a.ts")]);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "Fixed in the next commit" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(screen.getByText("Fixed in the next commit")).toBeTruthy();
    expect(screen.getByText(/sending/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(sent[0]?.body).toMatchObject({ thread: "A", body: "Fixed in the next commit" });
    await act(async () => sent[0]?.answer("refused"));
    const back = (await screen.findByRole("textbox", { name: "Reply" })) as HTMLTextAreaElement;
    expect(back.value).toBe("Fixed in the next commit");
    expect(screen.queryByText(/sending/)).toBeNull();
  });

  it("keeps an unsent reply when Escape closes the box", async () => {
    await writes([thread("A", "src/a.ts")]);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "Half a thought" } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Continue reply" }));
    expect((screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe(
      "Half a thought",
    );
  });
});

describe("a comment's mark", () => {
  it("is ocra's eyes on ocra's finding comment and a person's initial otherwise", async () => {
    const ocra = thread("t1", "src/a.ts");
    ocra.comments[0] = {
      id: "t1c",
      createdAt: null,
      author: "ocra-cloud",
      body: "<!-- ocra:finding e9953cfd0d2ebf46 -->\n**TTL in seconds** · warning · correctness\n\nText.",
      suggestions: [],
    };
    await show("github", [ocra, thread("t2", "src/b.ts")]);
    const marks = [...document.querySelectorAll(".thread-avatar")];
    expect(marks[0]?.querySelector("svg")).not.toBeNull();
    expect(marks[0]?.textContent).toBe("");
    expect(marks[1]?.textContent).toBe("R");
  });
});
