import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewChatView } from "../../../src/shared/index.js";
import { ReviewChat } from "./chat.js";

const A = "ocra-openrouter/vendor/model-a";
const B = "ocra-anthropic/claude-x";
const view = (over: Partial<ReviewChatView> = {}): ReviewChatView => ({
  messages: [],
  sharing: true,
  model: A,
  models: [A, B],
  limit: 100,
  ...over,
});
const stored = { id: "m2", role: "assistant", text: "It **caps** refunds.", createdAt: "x" };

/** An answer as the server streams it: one event per chunk. */
function sse(events: unknown[]): Response {
  const body = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function serve(v: ReviewChatView, answer: () => Response) {
  const sent: { method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json(v);
      sent.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return method === "POST" ? answer() : Response.json({ cleared: true });
    }),
  );
  return sent;
}

const box = () => screen.findByLabelText("Question about this review");

/** Opens the panel the way a click on its summary does (jsdom does not toggle a details). */
async function unfold(container: HTMLElement) {
  await box();
  const details = container.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ask ocra", () => {
  it("sends the question on Enter to the picked model and draws the answer as Markdown", async () => {
    const sent = serve(view(), () =>
      sse([
        { type: "delta", text: "It **caps**" },
        { type: "delta", text: " refunds." },
        { type: "done", message: stored },
      ]),
    );
    render(<ReviewChat reviewId="r1" />);
    fireEvent.change(await screen.findByLabelText("Model to ask"), { target: { value: B } });
    fireEvent.change(await box(), { target: { value: "Why critical?" } });
    await act(async () => void fireEvent.keyDown(await box(), { key: "Enter" }));
    await waitFor(() => expect(screen.getByText("caps").tagName).toBe("STRONG"));
    expect(sent).toEqual([{ method: "POST", body: { message: "Why critical?", model: B } }]);
    expect(screen.getByText("Why critical?").className).toContain("chat-question");
    expect(((await box()) as HTMLTextAreaElement).value).toBe("");
    expect(document.querySelector(".chat-caret")).toBeNull();
  });

  it("says it is thinking, with the seconds, until the first words arrive", async () => {
    let first: (r: Response) => void = () => {};
    const waiting = new Promise<Response>((resolve) => {
      first = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET" ? Response.json(view()) : waiting,
      ),
    );
    render(<ReviewChat reviewId="r1" />);
    fireEvent.change(await box(), { target: { value: "Why critical?" } });
    await act(async () => void fireEvent.keyDown(await box(), { key: "Enter" }));
    expect((await screen.findByText("Thinking")).parentElement?.textContent).toBe("Thinking0s");
    await act(async () =>
      first(
        sse([
          { type: "delta", text: "It caps." },
          { type: "done", message: stored },
        ]),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Thinking")).toBeNull());
  });

  it("opens on a stored conversation, and clears it", async () => {
    const sent = serve(
      view({
        messages: [
          { id: "m1", role: "user", text: "Why?", createdAt: "x" },
          { ...stored, role: "assistant" },
        ],
      }),
      () => sse([]),
    );
    const { container } = render(<ReviewChat reviewId="r1" />);
    await screen.findByText("Why?");
    expect(container.querySelector("details")?.open).toBe(true);
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Clear conversation" })),
    );
    expect(sent).toEqual([{ method: "DELETE", body: undefined }]);
    expect(screen.queryByText("Why?")).toBeNull();
    expect(
      screen.getByRole("button", { name: "What does this pull request change?" }),
    ).toBeTruthy();
  });

  it("says what each refusal needs, and keeps the question", async () => {
    const refuse = (error: string, extra: object = {}, status = 409) =>
      Response.json({ error, ...extra }, { status });
    const cases: [Response, RegExp, string | null][] = [
      [refuse("no_key", { provider: "openrouter" }), /no key for openrouter/, "Add a key"],
      [refuse("no_key", { provider: null }), /Choose a standard model/, "Choose a model"],
      [refuse("memory_full", { limit: 100 }), /holds its 100 messages/, null],
      [refuse("daily_limit", {}, 429), /used up/, "See the budget"],
      [sse([{ type: "error", error: "upstream_unreachable" }]), /provider did not answer/, null],
    ];
    for (const [response, says, link] of cases) {
      serve(view(), () => response);
      await unfold(render(<ReviewChat reviewId="r1" />).container);
      await act(
        async () =>
          void fireEvent.click(
            await screen.findByRole("button", { name: "What should I test before merging?" }),
          ),
      );
      expect((await screen.findByRole("alert")).textContent).toMatch(says);
      if (link) expect(screen.getByRole("link", { name: link })).toBeTruthy();
      expect(((await box()) as HTMLTextAreaElement).value).toBe(
        "What should I test before merging?",
      );
      cleanup();
    }
  });

  it("asks for a model before any question when the account has set none", async () => {
    serve(view({ model: null, models: [] }), () => sse([]));
    await unfold(render(<ReviewChat reviewId="r1" />).container);
    expect((await screen.findByRole("status")).textContent).toMatch(/Choose a standard model/);
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Model to ask")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "What does this pull request change?" }),
    ).toBeNull();
  });
});
