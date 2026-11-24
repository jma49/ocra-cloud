import { redact } from "@open-cr-agent/cloud-contract";

// Why a CLI run went wrong, from the end of what it wrote to stderr: kept
// short so it holds the error, not the code or model text around it, and
// redacted, so a key the run printed never reaches a log or the server.

const LINES = 3;
const LINE_CHARS = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes and control characters are what is removed
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** The last few lines the run wrote to stderr, redacted; null when it wrote none. */
export function runDetail(stderr: string | undefined): string | null {
  if (!stderr) return null;
  const lines = stderr
    .replace(CONTROL, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-LINES)
    .map((line) => redact(line).text.slice(0, LINE_CHARS));
  return lines.length > 0 ? lines.join("\n") : null;
}
