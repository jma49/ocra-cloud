import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";

// A company's OpenAI-compatible model endpoint, behind the same certificate
// authority as its GitLab, scripted as a reviewer that finds one defect: it
// reports it on the first turn of a review task, is done on the next, and
// then stops.
// Plain completions (the walkthrough, the verifier, an answer to a comment)
// get `answer(prompt)`.

export const MODEL = "coder";
export const KEY = "corp-llm-key";

type Message = { role: string; content?: unknown };
type Chat = {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  tools?: { function?: { name?: string } }[];
};

const text = (m: Message) =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";

export async function modelEndpoint(
  tls: { key: Buffer; cert: Buffer },
  finding: Record<string, string>,
  answer: (prompt: string) => string,
) {
  const chats: Chat[] = [];
  const keys: (string | undefined)[] = [];

  const reply = (res: ServerResponse, chat: Chat, message: Record<string, unknown>) => {
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const finish = message.tool_calls ? "tool_calls" : "stop";
    if (!chat.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: chat.model,
          choices: [
            { index: 0, message: { role: "assistant", ...message }, finish_reason: finish },
          ],
          usage,
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finishReason: string | null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: chat.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...extra,
        })}\n\n`,
      );
    const calls = message.tool_calls as { function: unknown; id: string }[] | undefined;
    chunk(
      calls
        ? { role: "assistant", tool_calls: calls.map((c, index) => ({ index, ...c })) }
        : { role: "assistant", content: message.content },
      null,
    );
    chunk({}, finish, { usage });
    res.end("data: [DONE]\n\n");
  };

  const server = createServer(tls, async (req, res) => {
    keys.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const chat = JSON.parse(Buffer.concat(chunks).toString()) as Chat;
    chats.push(chat);
    // The runtime may prefix the tools' names (ocra_report_finding).
    const tool = (name: string) => chat.tools?.find((t) => t.function?.name?.endsWith(name));
    const messages = chat.messages ?? [];
    const report = tool("report_finding")?.function?.name;
    const done = tool("task_done")?.function?.name;
    if (report && done) {
      // The finding, then task_done, then a last word: the runtime's loop ends on text.
      const turn = messages.filter((m) => m.role === "tool").length;
      if (turn >= 2) return reply(res, chat, { content: "Reviewed." });
      const call =
        turn === 1
          ? { name: done, arguments: "{}" }
          : { name: report, arguments: JSON.stringify(finding) };
      return reply(res, chat, {
        content: null,
        tool_calls: [{ id: `call_${chats.length}`, type: "function", function: call }],
      });
    }
    reply(res, chat, { content: answer(messages.map(text).join("\n")) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    chats,
    keys,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
