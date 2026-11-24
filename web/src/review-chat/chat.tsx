import Eraser from "lucide-react/icons/eraser";
import MessageSquare from "lucide-react/icons/message-square";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReviewChatMessageView, ReviewChatView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Elapsed } from "../elapsed.js";
import { count } from "../format.js";
import { IconButton } from "../icon-button.js";
import { Markdown } from "../markdown.js";
import { LoadError } from "../ui.js";
import { modelName, NoModel, Refusal } from "./refusal.js";
import { askReview } from "./stream.js";

// "Ask ocra" about this review or pull request: questions answered by the
// account's own model from what the review stored and the pull request's
// diff, the answer drawn as it streams.

const MAX_QUESTION = 4_000;
const STARTERS = [
  "What does this pull request change?",
  "Which finding matters most, and why?",
  "What should I test before merging?",
];

type Pending = { question: string; answer: string; askedAt: number };

export function ReviewChat(props: { reviewId: string }) {
  const path = `/reviews/${encodeURIComponent(props.reviewId)}/chat`;
  return <Chat read={path} ask={path} subject="this review" />;
}

export function Chat<M extends ReviewChatMessageView>(props: {
  /** Where the conversation is read and cleared. */
  read: string;
  /** Where a question is sent, with `extra` in its body. */
  ask: string;
  extra?: Record<string, unknown>;
  subject: string;
  /** What a question is about, chosen above the box. */
  about?: ReactNode;
  /** What a kept question was asked about, shown with it. */
  labelOf?: (m: M) => string | null;
}) {
  const path = props.read;
  const [view, setView] = useState<(Omit<ReviewChatView, "messages"> & { messages: M[] }) | null>(
    null,
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<unknown>(null);
  const log = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoadError(null);
    api<Omit<ReviewChatView, "messages"> & { messages: M[] }>(path).then((v) => {
      // Drawn only from a whole conversation: a box beside the page's other reads stays empty otherwise.
      if (!Array.isArray(v?.messages) || !Array.isArray(v.models)) return;
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
      const body = { ...props.extra, message, ...(model ? { model } : {}) };
      const answer = await askReview<M>(props.ask, body, (piece) =>
        setPending((p) => p && { ...p, answer: p.answer + piece }),
      );
      // The thread is read again for the question as kept, with what it was about.
      setView((v) => v && { ...v, messages: [...v.messages, asked(message) as M, answer] });
      if (props.labelOf) load();
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
        <h2 className="walkthrough-title">Ask ocra</h2>
        <span className="walkthrough-meta subtle small">
          {messages.length > 0
            ? count(messages.length, "message")
            : `Questions about ${props.subject}, answered by your model`}
        </span>
      </summary>
      {loadError !== null ? (
        <LoadError what="the conversation" error={loadError} retry={load} />
      ) : (
        view && (
          <div className="chat-body">
            {!view.sharing && (
              <p className="muted small m-0">
                This account does not share findings, so answers come from the review's counts and
                the pull request's diff alone.
              </p>
            )}
            {messages.length === 0 && !pending ? (
              view.model && (
                <ul className="chat-starters" aria-label="Suggested questions">
                  {STARTERS.map((s) => (
                    <li key={s}>
                      <button type="button" className="chat-starter" onClick={() => ask(s)}>
                        <MessageSquare size={14} aria-hidden="true" />
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <div className="chat-log" ref={log} role="log" aria-label="Conversation">
                {messages.map((m) => (
                  <Message
                    key={m.id}
                    from={m.role}
                    text={m.text}
                    label={props.labelOf?.(m) ?? null}
                  />
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
            {props.about}
            <div className={`chat-composer${view.model ? "" : " is-off"}`}>
              <textarea
                aria-label={`Question about ${props.subject}`}
                rows={2}
                maxLength={MAX_QUESTION}
                placeholder="Ask about a finding or the change"
                value={question}
                disabled={!view.model}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKey}
              />
              <div className="chat-tools">
                {view.models.length > 1 ? (
                  <select
                    className="chat-model"
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
                ) : (
                  asking && <span className="subtle small">{modelName(asking)}</span>
                )}
                <span className="grow" />
                <span className="chat-hint subtle small" aria-hidden="true">
                  Enter to send, Shift+Enter for a new line
                </span>
                {messages.length > 0 && (
                  <IconButton
                    label="Clear conversation"
                    icon={Eraser}
                    disabled={!!pending}
                    onClick={clear}
                  />
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
  label?: string | null;
  streamingSince?: number;
}) {
  if (props.from === "user") {
    return (
      <p className="chat-question pre-wrap">
        {props.label && <span className="subtle small mono">{props.label}: </span>}
        {props.text}
      </p>
    );
  }
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
