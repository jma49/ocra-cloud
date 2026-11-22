import { platformSend } from "../platforms/http.js";
import type { NotifyKind, NotifyWhen } from "../shared/index.js";

// A chat's incoming webhook: which addresses a kind takes, the message
// announcing a review, and its delivery. A message carries the review's
// counts and links, and the titles of its most severe findings when the
// account shares findings; titles are model text, so they are made plain.

/** Only the chat's own host: the server never posts to an address a user typed freely. */
const HOOKS: Record<NotifyKind, (u: URL) => boolean> = {
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
export function hookUrl(kind: NotifyKind, address: string): string | undefined {
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

/** The kinds of review a channel set to `when` hears about. */
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
function plain(text: string): string {
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

function lines(n: ReviewNotice, link: (label: string, url: string) => string): string[] {
  const what = n.pull ? link(n.pull.label, n.pull.url) : "a change";
  const counts = `${n.critical} critical · ${n.warning} warning · ${n.suggestion} suggestion`;
  const verdict = n.verdict ? ` · ${n.verdict.replaceAll("_", " ")}` : "";
  return [
    `ocra reviewed ${what}`,
    `${counts}${verdict}${n.complete ? "" : " · incomplete"}`,
    ...n.titles.map((t) => `• ${plain(t.title)} (${plain(t.file)})`),
    link("Open in ocra", n.consoleUrl),
  ];
}

/** The body the chat's webhook takes. */
export function messageOf(kind: NotifyKind, n: ReviewNotice): unknown {
  if (kind === "slack") {
    return { text: lines(n, (label, url) => `<${url}|${label}>`).join("\n") };
  }
  return {
    msgtype: "markdown",
    markdown: { content: lines(n, (label, url) => `[${label}](${url})`).join("\n") },
  };
}

/** Whether the chat took the message. */
export async function deliver(kind: NotifyKind, url: string, body: unknown): Promise<boolean> {
  const sent = await platformSend<{ errcode?: number }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sent || sent.status < 200 || sent.status >= 300) return false;
  // WeCom answers 200 with its error in the body.
  return kind !== "wecom" || sent.body?.errcode === 0;
}
