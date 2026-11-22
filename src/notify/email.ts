import { type Message, textOf } from "./channels.js";

// An email channel's address and its messages. The host brings the mailer
// (SMTP on Node, src/node/mailer.ts); a host without one sends no email.
// Every header value is refused if it could start another header, and every
// piece of text in the HTML body is escaped: titles and names are model or
// user text. No images, no tracking.

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

/** Sends one email; whether the server took it. */
export type Mailer = { send(mail: Mail): Promise<boolean> };

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The address as mail will go to it, or undefined: one plain mailbox
 * (no name, quotes, comments, list or IP literal), its domain lowercased
 * and made ASCII the way a URL host is.
 */
export function emailAddress(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length > 254 || /[\p{Cc}\s]/u.test(trimmed)) return undefined;
  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at);
  if (at < 1 || local.length > 64 || !LOCAL.test(local)) return undefined;
  const typed = trimmed.slice(at + 1);
  // A URL would read these as a port, path or credentials, not the host.
  if (/[/?#:@[\]\\%]/.test(typed)) return undefined;
  let domain: string;
  try {
    domain = new URL(`http://${typed}`).hostname;
  } catch {
    return undefined;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return undefined;
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return undefined;
  const address = `${local}@${domain}`;
  return address.length <= 254 ? address : undefined;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

function htmlOf(m: Message, footer: string): string {
  const paragraphs = m.lines.map(
    (line) =>
      `<p>${line
        .map((p) =>
          typeof p === "string"
            ? escapeHtml(p)
            : `<a href="${escapeHtml(p.url)}">${escapeHtml(p.label)}</a>`,
        )
        .join("")}</p>`,
  );
  return `<!doctype html><html><body>${paragraphs.join("")}<hr><p><small>${footer}</small></p></body></html>`;
}

/** The email of a message to one address, with its one-click unsubscribe link. */
export function mailOf(m: Message, to: string, unsubscribeUrl: string): Mail {
  const why = "You get this because this address was added to an ocra account's notifications.";
  return {
    to,
    subject: m.subject.replace(/[\p{Cc}\s]+/gu, " ").trim(),
    text: `${textOf(m)}\n\n--\n${why}\nUnsubscribe: ${unsubscribeUrl}\n`,
    html: htmlOf(m, `${escapeHtml(why)} <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>`),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Whether no header value could end its header and start another. */
function headersSafe(mail: Mail): boolean {
  const values = [
    mail.to,
    mail.subject,
    ...Object.keys(mail.headers),
    ...Object.values(mail.headers),
  ];
  return values.every((v) => !/[\r\n\p{Cc}]/u.test(v)) && emailAddress(mail.to) === mail.to;
}

/** Sends the mail when its headers are safe; whether the server took it. Never throws. */
export async function sendMail(mailer: Mailer, mail: Mail): Promise<boolean> {
  if (!headersSafe(mail)) return false;
  try {
    return await mailer.send(mail);
  } catch {
    return false;
  }
}
