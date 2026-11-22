// "Ask ocra" about one review: the conversation the review page shows, and
// the events of an answer as it streams (text/event-stream, one JSON event
// per `data:` line).

export const REVIEW_CHAT_ROLES = ["user", "assistant"] as const;
export type ReviewChatRole = (typeof REVIEW_CHAT_ROLES)[number];

export type ReviewChatMessageView = {
  id: string;
  role: ReviewChatRole;
  text: string;
  createdAt: string;
};

export type ReviewChatView = {
  messages: ReviewChatMessageView[];
  /** Whether the account shares findings: without, answers come from the counts alone. */
  sharing: boolean;
  /** The model a question goes to unless it names one: the account's standard tier; null with none set. */
  model: string | null;
  /** The most messages a review's conversation keeps; clear it to ask more. */
  limit: number;
};

export type ReviewChatEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message: ReviewChatMessageView }
  | { type: "error"; error: "upstream_unreachable" | "internal" };
