import { outboundFetch } from "../calls.js";
import { deadline } from "../deadline.js";
import { boundedBytes } from "../platforms/http.js";
import type { NotifyDeliveryEvent, NotifyKind, NotifyWhen, WebhookPull } from "../shared/index.js";
import { type Attempt, DELIVERED, type Outcome, REFUSED } from "./deliveries.js";
import type { HookEvent } from "./webhooks.js";

// A chat's incoming webhook: which addresses a kind takes, the message
// announcing a review, and one attempt of its delivery. A message carries the review's
// counts and links, and the titles of its most severe findings when the
// account shares findings; titles are model text, so they are made plain.

export type HookKind = Exclude<NotifyKind, "email" | "webhook">;

/** Only the chat's own host: the server never posts to an address a user typed freely. */
const HOOKS: Record<HookKind, (u: URL) => boolean> = {
  slack: (u) =>
    u.hostname === "hooks.slack.com" &&
    /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(u.pathname),
  wecom: (u) =>
    u.hostname === "qyapi.weixin.qq.com" &&
    u.pathname === "/cgi-bin/webhook/send" &&
    /^[\w-]{8,64}$/.test(u.searchParams.get("key") ?? "") &&
    [...u.searchParams.keys()].length === 1,
};

/** The webhook address as it will be called, or undefined when the kind does not take it. */
export function hookUrl(kind: HookKind, address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) {
    return undefined;
  }
  return HOOKS[kind](url) ? url.toString() : undefined;
}

/**
 * The settings of `when` that hear about a review with these counts; for
 * a digest or report, the counts of its reviews with a critical finding and
 * with any, so a channel gets it only when one of them is a review it hears about.
 */
export function whensFor(counts: { critical: number; findings: number }): NotifyWhen[] {
  if (counts.critical > 0) return ["blocking", "findings", "every"];
  if (counts.findings > 0) return ["findings", "every"];
  return ["every"];
}

export type ReviewNotice = {
  /** `octo/api#7` and its address, for a pull request's review. */
  pull: { label: string; url: string } | null;
  critical: number;
  warning: number;
  suggestion: number;
  verdict: string | null;
  complete: boolean;
  /** At most three, most severe first. */
  titles: { title: string; file: string }[];
  consoleUrl: string;
};

const MAX_TITLE = 120;

/** One line of model text with nothing a chat reads as markup or a mention. */
export function plain(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const safe = [...line]
    .filter((ch) => !/\p{Cc}/u.test(ch))
    .map((ch) => ("<>&[]()*_~`@#|".includes(ch) ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  const chars = [...safe];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("")}…` : safe;
}

/** Text, or a link; a renderer turns each into its medium's form. */
type Piece = string | { label: string; url: string };
/** A message's words: the subject only an email shows, then its lines. */
export type MessageText = { subject: string; lines: Piece[][] };
/** What a channel is told, as its delivery log names it; a webhook gets hooks instead. */
export type Message = MessageText & { event: NotifyDeliveryEvent; hooks?: HookEvent[] };

export function reviewMessage(n: ReviewNotice): Message {
  const counts = `${n.critical} critical · ${n.warning} warning · ${n.suggestion} suggestion`;
  const verdict = n.verdict ? ` · ${n.verdict.replaceAll("_", " ")}` : "";
  return {
    event: "review_completed",
    subject: `ocra reviewed ${n.pull ? plain(n.pull.label) : "a change"}: ${counts}`,
    lines: [
      ["ocra reviewed ", n.pull ?? "a change"],
      [`${counts}${verdict}${n.complete ? "" : " · incomplete"}`],
      ...n.titles.map((t) => [`• ${plain(t.title)} (${plain(t.file)})`]),
      [{ label: "Open in ocra", url: n.consoleUrl }],
    ],
  };
}

/** A rule's notice: which rule ran on which pull request. Its name is the account's text, made plain too. */
export type RuleNotice = {
  rule: string;
  pull: { label: string; url: string | null };
  consoleUrl: string;
  /** The pull request as a webhook names it; null where its platform is not configured. */
  hookPull: WebhookPull | null;
};

/** The message of an automation rule that ran. */
export function ruleMessage(n: RuleNotice): Message {
  const pull: Piece = n.pull.url ? { label: n.pull.label, url: n.pull.url } : plain(n.pull.label);
  return {
    event: "automation_ran",
    subject: `ocra automation "${plain(n.rule)}" ran on ${plain(n.pull.label)}`,
    lines: [
      [`ocra automation "${plain(n.rule)}" ran on `, pull],
      [{ label: "Open in ocra", url: n.consoleUrl }],
    ],
    hooks: [{ event: "automation_ran", data: { rule: plain(n.rule), pull: n.hookPull } }],
  };
}

const render = (m: MessageText, link: (label: string, url: string) => string) =>
  m.lines.map((line) =>
    line.map((p) => (typeof p === "string" ? p : link(p.label, p.url))).join(""),
  );

/** The body the chat's webhook takes. */
export function messageOf(kind: HookKind, m: MessageText): unknown {
  if (kind === "slack") {
    return { text: render(m, (label, url) => `<${url}|${label}>`).join("\n") };
  }
  return {
    msgtype: "markdown",
    markdown: { content: render(m, (label, url) => `[${label}](${url})`).join("\n") },
  };
}

/** The message as plain text, each link after its label. */
export const textOf = (m: MessageText): string =>
  render(m, (label, url) => `${label}: ${url}`).join("\n");

const TIMEOUT_MS = 10_000;
/** Bytes of a chat's answer read; its error code is short. */
const MAX_ANSWER = 4096;

/**
 * Slack's answers that no retry changes: the webhook was revoked, its
 * channel is gone or archived, or the body is wrong. Any other failure is
 * read by its status.
 */
const SLACK_PERMANENT = new Set([
  "invalid_token",
  "invalid_auth",
  "no_service",
  "no_service_id",
  "no_team",
  "team_disabled",
  "channel_not_found",
  "channel_is_archived",
  "action_prohibited",
  "posting_to_general_channel_denied",
  "invalid_payload",
  "no_text",
]);
/** WeCom's errcodes worth another try: system busy, and its rate limit. */
const WECOM_TRANSIENT = new Set([-1, 45009]);

const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

function chatOutcome(kind: HookKind, status: number, answer: string): Outcome {
  if (status >= 300 && status < 400) return { status, error: "redirect", transient: false };
  if (kind === "slack") {
    if (status >= 200 && status < 300) return DELIVERED(status);
    const permanent = SLACK_PERMANENT.has(answer.trim());
    return { status, error: "status", transient: !permanent && transientStatus(status) };
  }
  if (status < 200 || status >= 300) {
    return { status, error: "status", transient: transientStatus(status) };
  }
  // WeCom answers 200 with its error in the body.
  let errcode: unknown;
  try {
    errcode = (JSON.parse(answer) as { errcode?: unknown }).errcode;
  } catch {
    errcode = undefined;
  }
  if (errcode === 0) return DELIVERED(status);
  return {
    status,
    error: "rejected",
    transient: typeof errcode === "number" && WECOM_TRANSIENT.has(errcode),
  };
}

/**
 * One attempt of a chat message (its body as messageOf made it) to the
 * chat's webhook address, which is checked again first; no redirect is
 * followed. Only the answer's status and error code are read, never kept.
 */
export function chatAttempt(kind: HookKind, address: string): Attempt {
  return async (delivery) => {
    const url = hookUrl(kind, address);
    if (!url) return REFUSED;
    const clock = deadline(TIMEOUT_MS);
    try {
      const res = await outboundFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: delivery.payload,
        redirect: "manual",
        signal: clock.signal,
      });
      const bytes = await boundedBytes(res, MAX_ANSWER);
      return chatOutcome(kind, res.status, bytes ? new TextDecoder().decode(bytes) : "");
    } catch {
      return { status: null, error: clock.timedOut() ? "timeout" : "network", transient: true };
    } finally {
      clock.clear();
    }
  };
}
