import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  ReviewChatEvent,
  ReviewChatMessageView,
  ReviewChatView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";

// "Ask ocra" about this review: questions answered by the account's own
// model from what the review stored and the pull request's diff. Answers
// are model output about untrusted code, so they are shown as plain text.

const MAX_QUESTION = 4_000;

async function readError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(res.status, body.error as ApiError["code"]);
}

/** Reads the answer's events as they come; the finished message, or throws. */
async function stream(
  res: Response,
  onText: (text: string) => void,
): Promise<ReviewChatMessageView> {
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(502, "upstream_unreachable");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = done ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      if (!block.startsWith("data: ")) continue;
      const event = JSON.parse(block.slice(6)) as ReviewChatEvent;
      if (event.type === "delta") onText(event.text);
      if (event.type === "done") return event.message;
      if (event.type === "error") throw new ApiError(502, event.error);
    }
    if (done) throw new ApiError(502, "upstream_unreachable");
  }
}

export function ReviewChat(props: { reviewId: string }) {
  const path = `/reviews/${encodeURIComponent(props.reviewId)}/chat`;
  const [view, setView] = useState<ReviewChatView | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ReviewChatView>(path).then(setView, (e) => setError(why(e)));
  }, [path]);

  async function ask() {
    const message = question.trim();
    if (!message || pending || !view) return;
    setError(null);
    setPending({ question: message, answer: "" });
    try {
      const res = await fetch(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw await readError(res);
      const answer = await stream(res, (text) =>
        setPending((p) => p && { ...p, answer: p.answer + text }),
      );
      setView((v) => v && { ...v, messages: [...v.messages, asked(message), answer] });
      setQuestion("");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "no_key"
          ? "add a provider key and choose a standard model in Settings to ask ocra"
          : why(e),
      );
    } finally {
      setPending(null);
    }
  }

  async function clear() {
    setError(null);
    try {
      await api(path, { method: "DELETE" });
      setView((v) => v && { ...v, messages: [] });
    } catch (e) {
      setError(why(e));
    }
  }

  const messages = view?.messages ?? [];
  return (
    <details className="card">
      <summary className="walkthrough-head">
        <span className="fold" aria-hidden="true" />
        <span className="strong">Ask ocra</span>
        {view?.model && <span className="subtle small mono">{view.model}</span>}
      </summary>
      <div className="card-pad stack">
        {view && !view.sharing && (
          <p className="muted small m-0">
            This account does not share findings, so answers come from the review's counts and the
            pull request alone.
          </p>
        )}
        {messages.map((m) => (
          <p key={m.id} className={`pre-wrap m-0${m.role === "user" ? " strong" : ""}`}>
            {m.text}
          </p>
        ))}
        {pending && (
          <>
            <p className="pre-wrap m-0 strong">{pending.question}</p>
            <p className="pre-wrap m-0" aria-live="polite">
              {pending.answer || "…"}
            </p>
          </>
        )}
        {error && (
          <p className="note err small m-0" role="alert">
            Could not answer: {error}.
          </p>
        )}
        <textarea
          aria-label="Question about this review"
          className="input"
          rows={3}
          maxLength={MAX_QUESTION}
          placeholder="Why is this finding critical? What does this pull request change?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="row-gap">
          <Button size="sm" disabled={!question.trim() || !!pending || !view} onClick={ask}>
            Ask
          </Button>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" disabled={!!pending} onClick={clear}>
              Clear conversation
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}

const asked = (text: string): ReviewChatMessageView => ({
  id: `asked-${Date.now()}`,
  role: "user",
  text,
  createdAt: new Date().toISOString(),
});
