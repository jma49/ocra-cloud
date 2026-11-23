import { outboundFetch } from "../calls.js";
import { deadline } from "../deadline.js";
import { boundedBytes } from "../platforms/http.js";
import { type Attempt, DELIVERED, type Outcome, REFUSED } from "./deliveries.js";
import { emailAddress } from "./email.js";

// A Slack member's direct messages, sent by the server's own Slack app
// (SLACK_BOT_TOKEN): the member is found by the email address or member ID
// the user typed, and their direct message conversation opened once, when
// the channel is added; each message is then one chat.postMessage there.
// A channel gets nothing until the member opens the link sent to them, so
// a user cannot have ocra message someone else. The token, the text sent
// and what Slack answers are never logged or kept.

/** Where a channel's messages go: the member, and their conversation with the app. */
export type SlackDmTarget = { user: string; channel: string };

const API = "https://slack.com/api/";
const TIMEOUT_MS = 10_000;
/** Bytes of an answer read; users.info's is the largest, a profile. */
const MAX_ANSWER = 64 * 1024;
const MEMBER_ID = /^[UW][A-Z0-9]{2,20}$/;
const DM_ID = /^D[A-Z0-9]{2,20}$/;

type Answer = {
  ok?: unknown;
  error?: unknown;
  user?: { id?: unknown; deleted?: unknown; is_bot?: unknown };
  channel?: { id?: unknown };
};

type Called = { status: number; answer: Answer } | { status: null; error: "timeout" | "network" };

async function call(token: string, method: string, params: Record<string, string>) {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await outboundFetch(`${API}${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      redirect: "manual",
      signal: clock.signal,
    });
    const bytes = await boundedBytes(res, MAX_ANSWER);
    let answer: Answer = {};
    try {
      answer = JSON.parse(bytes ? new TextDecoder().decode(bytes) : "") as Answer;
    } catch {
      answer = {};
    }
    return { status: res.status, answer } satisfies Called;
  } catch {
    return { status: null, error: clock.timedOut() ? "timeout" : "network" } satisfies Called;
  } finally {
    clock.clear();
  }
}

/** Slack's answer when it went; undefined when it did not. */
const okAnswer = (c: Called): Answer | undefined =>
  c.status === 200 && c.answer.ok === true ? c.answer : undefined;

/** not_found: no member by that address or ID; not_a_person: a bot or a deactivated member. */
export type SlackMemberFound =
  | { target: SlackDmTarget }
  | { refused: "invalid" | "not_found" | "not_a_person" }
  | { unreachable: true };

const NOT_FOUND = new Set(["users_not_found", "user_not_found"]);

/**
 * The member the user typed (an email address, or a member ID such as
 * U012AB3CD) and their direct message conversation with the app, opened now.
 */
export async function findSlackMember(token: string, typed: string): Promise<SlackMemberFound> {
  const input = typed.trim();
  const email = input.includes("@") ? emailAddress(input) : undefined;
  if (!email && !MEMBER_ID.test(input)) return { refused: "invalid" };
  const found = email
    ? await call(token, "users.lookupByEmail", { email })
    : await call(token, "users.info", { user: input });
  const answer = okAnswer(found);
  if (!answer) {
    const error = "answer" in found ? found.answer.error : undefined;
    return typeof error === "string" && NOT_FOUND.has(error)
      ? { refused: "not_found" }
      : { unreachable: true };
  }
  const user = answer.user;
  const id = user?.id;
  if (typeof id !== "string" || !MEMBER_ID.test(id)) return { unreachable: true };
  if (user?.deleted === true || user?.is_bot === true || id === "USLACKBOT") {
    return { refused: "not_a_person" };
  }
  const opened = await call(token, "conversations.open", { users: id, return_im: "false" });
  const channel = okAnswer(opened)?.channel?.id;
  if (typeof channel !== "string" || !DM_ID.test(channel)) return { unreachable: true };
  return { target: { user: id, channel } };
}

/** The target as sealed to its channel's row, or undefined when it is not one. */
export function slackTargetOf(sealed: string): SlackDmTarget | undefined {
  try {
    const t = JSON.parse(sealed) as Partial<SlackDmTarget>;
    return typeof t.user === "string" &&
      MEMBER_ID.test(t.user) &&
      typeof t.channel === "string" &&
      DM_ID.test(t.channel)
      ? { user: t.user, channel: t.channel }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Slack's errors that a later attempt may not meet: its rate limit, and its own failures. */
const TRANSIENT = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/**
 * How Slack answered a message. Any error it names in a 200 is permanent
 * (the member deactivated, the app removed, its token revoked, a missing
 * scope), but its rate limit and its own failures; a 429 or 5xx is tried again.
 */
export function slackDmOutcome(status: number, answer: Answer): Outcome {
  if (status >= 300 && status < 400) return { status, error: "redirect", transient: false };
  if (status === 429 || status >= 500 || status === 408) {
    return { status, error: "status", transient: true };
  }
  if (status !== 200) return { status, error: "status", transient: false };
  if (answer.ok === true) return DELIVERED(status);
  const error = typeof answer.error === "string" ? answer.error : "";
  return { status, error: "rejected", transient: TRANSIENT.has(error) };
}

/** Characters of text a message carries at most, as Slack advises. */
const MAX_TEXT = 4000;

/**
 * One attempt of a direct message: its body as messageOf("slack") made it,
 * posted in the member's conversation with the app.
 */
export function slackDmAttempt(token: string, target: SlackDmTarget): Attempt {
  return async (delivery) => {
    let text: unknown;
    try {
      text = (JSON.parse(delivery.payload) as { text?: unknown }).text;
    } catch {
      text = undefined;
    }
    if (typeof text !== "string" || text.length === 0) return REFUSED;
    const sent = await call(token, "chat.postMessage", {
      channel: target.channel,
      text: text.slice(0, MAX_TEXT),
      unfurl_links: "false",
      unfurl_media: "false",
    });
    if (sent.status === null) return { status: null, error: sent.error, transient: true };
    return slackDmOutcome(sent.status, sent.answer);
  };
}
