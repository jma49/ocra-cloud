import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { smtpMailer } from "../src/node/mailer.js";
import { mailAttempt, mailBody, mailOf } from "../src/notify/email.js";

// The self-hosted server's SMTP mailer, against a local server that takes
// one message per connection and keeps what it was sent.

let server: Server | undefined;
afterEach(() => server?.close());

async function smtpServer(rcptReply = "250 ok") {
  const received: { rcpt: string[]; data: string }[] = [];
  server = createServer((socket) => {
    const msg = { rcpt: [] as string[], data: "" };
    let inData = false;
    let buffer = "";
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(msg);
            socket.write("250 queued\r\n");
          } else msg.data += `${line}\n`;
        } else if (/^(EHLO|HELO)/i.test(line)) socket.write("250 test\r\n");
        else if (/^RCPT TO:/i.test(line)) {
          msg.rcpt.push(line.slice(8).trim());
          socket.write(`${rcptReply}\r\n`);
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { received, url: `smtp://127.0.0.1:${port}` };
}

describe("the SMTP mailer", () => {
  it("is off without SMTP_URL, and refuses a malformed one or sender", () => {
    expect(smtpMailer(undefined, undefined)).toBeUndefined();
    expect(() => smtpMailer("https://mail.example.com", "ocra@example.com")).toThrow("SMTP_URL");
    expect(() => smtpMailer("smtp://mail.example.com", undefined)).toThrow("SMTP_FROM");
    expect(() => smtpMailer("smtp://mail.example.com", "ocra@example.com\r\nBcc: x@y.z")).toThrow(
      "SMTP_FROM",
    );
  });

  it("sends the text and HTML parts to the one recipient, with the unsubscribe headers", async () => {
    const { received, url } = await smtpServer();
    const mailer = smtpMailer(url, "ocra@example.com");
    const mail = mailOf(
      { subject: "ocra reviewed octo/api#7", lines: [["<b>hi</b>"]] },
      "ann@example.com",
      "https://ocra.test/api/email/unsubscribe?t=x",
    );
    expect(await mailer?.send(mail)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.rcpt).toEqual(["<ann@example.com>"]);
    const data = received[0]?.data ?? "";
    expect(data).toContain("From: ocra@example.com");
    expect(data).toContain("List-Unsubscribe: <https://ocra.test/api/email/unsubscribe?t=x>");
    expect(data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(data).toContain("text/plain");
    expect(data).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("is given up on a 5xx reply and tried again on a 4xx, keeping only the code", async () => {
    const message = { subject: "ocra reviewed octo/api#7", lines: [["hi"]] };
    const delivery = {
      id: "d1",
      event: "ping" as const,
      payload: JSON.stringify(mailBody(message, "https://ocra.test/api/email/unsubscribe?t=x")),
    };
    for (const [reply, outcome] of [
      ["550 5.1.1 no such user", { status: 550, error: "status", transient: false }],
      ["451 4.7.1 try again later", { status: 451, error: "status", transient: true }],
      ["250 ok", { status: null, error: null, transient: false }],
    ] as const) {
      const { url } = await smtpServer(reply);
      const mailer = smtpMailer(url, "ocra@example.com");
      if (!mailer) throw new Error("no mailer");
      const attempt = mailAttempt(mailer, "ann@example.com");
      expect(await attempt(delivery, new Date()), reply).toEqual(outcome);
      server?.close();
    }
  });
});
