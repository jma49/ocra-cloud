import { redact } from "@open-cr-agent/cloud-contract";
import { outboundFetch } from "../calls.js";
import { deadline } from "../deadline.js";
import { notePlatformLimit } from "./rate-limit.js";

// The end of a CI job's log, read live as the user: the platform's answer
// may redirect to storage elsewhere, which is asked without the user's
// token. A log is a test's output, so anything may be in it: it is cut,
// cleaned and redacted here, never stored or logged.

/** How much of a log the platform is asked for: well over the lines kept, with their timestamps. */
const LOG_TAIL_BYTES = 256 * 1024;
/** A log longer than this is not read to its end. */
const MAX_LOG_SOURCE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

// Mirrors the engine's; the contract's checkLogTail and CHECK_LOG_LIMITS replace these when the pin reaches 0.23.1.
export const CHECK_LOG_LIMITS = { lines: 200, chars: 20_000 } as const;
const TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})? ?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
// GitHub Actions opens a step with this line and names what failed with the next.
const STEP = /^##\[group\]Run /;
const FAILED = /^##\[error\]/;
// GitLab marks where the job's own script starts and ends, on the line of what follows.
const SECTION_MARK = /(section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?)\r/g;
const SCRIPT_START = /section_start:\d+:step_script/;
const SCRIPT_END = /section_end:\d+:step_script/;

// The lines of the step that failed, so that what ran after it does not
// fill the tail: on GitHub Actions from the failed step's first line to the
// last line naming an error, on GitLab the job's script section, else all.
function failedStep(lines: string[]): string[] {
  const failed = lines.findLastIndex((line) => FAILED.test(line));
  if (failed >= 0) {
    const step = lines.findLastIndex((line, at) => at < failed && STEP.test(line));
    return lines.slice(Math.max(step, 0), failed + 1);
  }
  const start = lines.findLastIndex((line) => SCRIPT_START.test(line));
  if (start < 0) return lines;
  const end = lines.findIndex((line, at) => at > start && SCRIPT_END.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

export function checkLogTail(log: string): string {
  const lines = log
    .replace(SECTION_MARK, "$1\n")
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").replace(CONTROL, "").replace(TIMESTAMP, "").trimEnd())
    .filter((line) => line !== "");
  const tail = failedStep(lines).slice(-CHECK_LOG_LIMITS.lines).join("\n");
  return tail.length > CHECK_LOG_LIMITS.chars ? tail.slice(-CHECK_LOG_LIMITS.chars) : tail;
}

/** A log or a check's report as the console shows it: its tail, redacted. */
export function shownLog(text: string): { log: string; redacted: boolean } {
  const { text: log, redacted } = redact(checkLogTail(text));
  return { log, redacted };
}

/** The answer's last `keep` bytes as text; "" for one too long to read to its end. */
async function readTail(res: Response, keep: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const kept: Uint8Array[] = [];
  let held = 0;
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > MAX_LOG_SOURCE_BYTES) return "";
      kept.push(value);
      held += value.byteLength;
      while (kept.length > 1 && held - (kept[0]?.byteLength ?? 0) >= keep) {
        held -= kept.shift()?.byteLength ?? 0;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(held);
  let at = 0;
  for (const chunk of kept) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(Math.max(0, held - keep)));
}

/**
 * The end of the log at `url`, asked with `headers` (the user's token); a
 * redirect is followed once, to an https address, without them. null when
 * the platform refused, had none or took too long.
 */
export async function logTailAt(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    let res = await outboundFetch(url, { headers, redirect: "manual", signal: clock.signal });
    notePlatformLimit(res);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (!location) return null;
      const target = new URL(location, url);
      if (target.protocol !== "https:" || target.username || target.password) return null;
      res = await outboundFetch(target.toString(), { redirect: "manual", signal: clock.signal });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await readTail(res, LOG_TAIL_BYTES);
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}
