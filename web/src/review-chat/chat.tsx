import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReviewChatMessageView, ReviewChatView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Elapsed } from "../elapsed.js";
import { Markdown } from "../markdown.js";
import { LoadError } from "../ui.js";
import { modelName, NoModel, Refusal } from "./refusal.js";
import { askReview } from "./stream.js";

// "Ask ocra" about this review: questions answered by the account's own
// model from what the review stored and the pull request's diff, the answer
// drawn as it streams.

const MAX_QUESTION = 4_000;
const STARTERS = [
  "What does this pull request change?",
  "Which finding matters most, and why?",
  "What should I test before merging?",
];

type Pending = { question: string; answer: string; askedAt: number };

export function ReviewChat(props: { reviewId: string }) {
  const path = `/reviews/${encodeURIComponent(props.reviewId)}/chat`;
  const [view, setView] = useState<ReviewChatView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<unknown>(null);
  const log = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoadError(null);
    api<ReviewChatView>(path).then((v) => {
      setView(v);
      if (v.messages.length > 0) setOpen(true);
    }, setLoadError);
  };
  useEffect(load, [path]);

  const messages = view?.messages ?? [];
  const shown = messages.length + (pending ? pending.answer.length : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the conversation as it grows
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [shown, open]);

  async function ask(text = question) {
    const message = text.trim();
    if (!message || pending || !view) return;
    setError(null);
    setPending({ question: message, answer: "", askedAt: Date.now() });
    try {
      const answer = await askReview(path, { message, ...(model ? { model } : {}) }, (piece) =>
        setPending((p) => p && { ...p, answer: p.answer + piece }),
      );
      setView((v) => v && { ...v, messages: [...v.messages, asked(message), answer] });
      setQuestion("");
    } catch (e) {
      // The question stays in the box, to send again once what refused it is lifted.
      setQuestion(message);
      setError(e);
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
      setError(e);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void ask();
  };

  const asking = model ?? view?.model ?? null;
  return (
    <details
      className="card chat"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="walkthrough-head">
        <span className="fold" aria-hidden="true" />
        <span className="strong">Ask ocra</span>
        {messages.length > 0 && <span className="subtle small">{messages.length} messages</span>}
        {asking && <span className="subtle small mono chat-model">{modelName(asking)}</span>}
      </summary>
      {loadError !== null ? (
        <LoadError what="the conversation" error={loadError} retry={load} />
      ) : (
        view && (
          <div className="chat-body">
            {!view.sharing && (
              <p className="muted small m-0">
                This account does not share findings, so answers come from the review's counts and
                the pull request alone.
              </p>
            )}
            {messages.length === 0 && !pending ? (
              view.model && (
                <div className="chat-starters">
                  {STARTERS.map((s) => (
                    <Button key={s} size="sm" variant="outline" onClick={() => ask(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              )
            ) : (
              <div className="chat-log" ref={log} role="log" aria-label="Conversation">
                {messages.map((m) => (
                  <Message key={m.id} from={m.role} text={m.text} />
                ))}
                {pending && (
                  <>
                    <Message from="user" text={pending.question} />
                    <Message
                      from="assistant"
                      text={pending.answer}
                      streamingSince={pending.askedAt}
                    />
                  </>
                )}
              </div>
            )}
            {!view.model && <NoModel />}
            {error !== null && <Refusal error={error} limit={view.limit} onClear={clear} />}
            <div className="chat-ask">
              <textarea
                aria-label="Question about this review"
                className="input"
                rows={2}
                maxLength={MAX_QUESTION}
                placeholder="Ask about a finding or the change. Enter sends, Shift+Enter adds a line."
                value={question}
                disabled={!view.model}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKey}
              />
              <div className="chat-tools">
                {view.models.length > 1 && (
                  <select
                    className="input mono"
                    aria-label="Model to ask"
                    value={asking ?? ""}
                    disabled={!!pending}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {view.models.map((m) => (
                      <option key={m} value={m}>
                        {modelName(m)}
                      </option>
                    ))}
                  </select>
                )}
                <span className="grow" />
                {messages.length > 0 && (
                  <Button size="sm" variant="ghost" disabled={!!pending} onClick={clear}>
                    Clear conversation
                  </Button>
                )}
                <Button
                  size="sm"
                  loading={!!pending}
                  disabled={!question.trim() || !view.model}
                  onClick={() => ask()}
                >
                  Ask
                </Button>
              </div>
            </div>
          </div>
        )
      )}
    </details>
  );
}

function Message(props: {
  from: ReviewChatMessageView["role"];
  text: string;
  streamingSince?: number;
}) {
  if (props.from === "user") return <p className="chat-question pre-wrap">{props.text}</p>;
  const streaming = props.streamingSince !== undefined;
  if (streaming && props.text === "") {
    return (
      <p className="chat-thinking">
        <span className="shimmer-text">Thinking</span>
        <Elapsed since={props.streamingSince} />
      </p>
    );
  }
  return (
    <div className="chat-answer" aria-busy={streaming || undefined}>
      <Markdown text={props.text} />
      {streaming && <span className="chat-caret" aria-hidden="true" />}
    </div>
  );
}

const asked = (text: string): ReviewChatMessageView => ({
  id: `asked-${Date.now()}`,
  role: "user",
  text,
  createdAt: new Date().toISOString(),
});
