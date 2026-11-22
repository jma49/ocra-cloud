import { createTransport } from "nodemailer";
import { emailAddress, type Mail, type Mailer } from "../notify/email.js";

// Email on the self-hosted server: SMTP_URL (smtp:// with STARTTLS when
// the server offers it, smtps:// for TLS from the start) and SMTP_FROM.
// Every wait is bounded; a message that fails is reported, not retried.

const TIMEOUT_MS = 15_000;

/** The mailer of SMTP_URL and SMTP_FROM, or undefined without SMTP_URL; throws on a bad setting. */
export function smtpMailer(url: string | undefined, from: string | undefined): Mailer | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SMTP_URL must be an smtp:// or smtps:// URL");
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") {
    throw new Error("SMTP_URL must be an smtp:// or smtps:// URL");
  }
  const sender = from && emailAddress(from);
  if (!sender) throw new Error("SMTP_FROM must be the address email is sent from");
  const transport = createTransport({
    url: parsed.toString(),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    async send(mail: Mail) {
      const info = await transport.sendMail({
        from: sender,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: mail.headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return info.accepted.length > 0;
    },
  };
}
