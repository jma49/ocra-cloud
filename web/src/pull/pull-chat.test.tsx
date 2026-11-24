import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullChatView, PullFindingView } from "../../../src/shared/index.js";
import { PullChat } from "./pull-chat.js";

const A = "ocra-openrouter/vendor/model-a";
const asked = {
  id: "m1",
  role: "user",
  text: "Why critical?",
  finding: "f1",
  file: null,
  createdAt: "x",
};
const answer = {
  id: "m2",
  role: "assistant",
  text: "It drops the cache.",
  finding: null,
  file: null,
  createdAt: "y",
};
const finding = { id: "f1", title: "Cache disabled", file: "src/cache.ts" } as PullFindingView;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ask ocra on a pull request", () => {
  it("asks about the finding chosen, and shows what each question was about", async () => {
    const sent: { url: string; body: unknown }[] = [];
    let messages: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          return Response.json({
            messages,
            sharing: true,
            model: A,
            models: [A],
            limit: 100,
          } satisfies Omit<PullChatView, "messages"> & { messages: unknown[] });
        }
        sent.push({ url, body: JSON.parse(String(init?.body)) });
        messages = [asked, answer];
        const event = `data: ${JSON.stringify({ type: "done", message: answer })}\n\n`;
        return new Response(event, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    render(
      <PullChat
        pull={{ platform: "github", repo: "octo/api", number: 7 }}
        findings={[finding]}
        files={["src/cache.ts"]}
      />,
    );
    fireEvent.change(await screen.findByLabelText("What the question is about"), {
      target: { value: "finding:f1" },
    });
    const box = await screen.findByLabelText("Question about this pull request");
    fireEvent.change(box, { target: { value: "Why critical?" } });
    await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
    await waitFor(() => expect(screen.getByText("Finding Cache disabled:")).toBeTruthy());
    expect(sent).toEqual([
      {
        url: "/api/pulls/chat",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 7,
          finding: "f1",
          message: "Why critical?",
        },
      },
    ]);
  });
});
