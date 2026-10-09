// The Worker's own log lines: one JSON object each, which Workers Logs
// indexes field by field (audit C10). Never a body, key, token, secret or an
// error's message, which may quote a request; ids are Cloudflare's ray id,
// nothing that names a person.

type Fields = Record<string, string | number | boolean | null>;

export function logError(event: string, fields: Fields): void {
  console.error({ level: "error", event, ...fields });
}

/** An error's kind for a log: its name, never its message. */
export const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");
