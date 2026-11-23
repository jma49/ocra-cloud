import { z } from "zod";
import {
  type Assignment,
  type RUN_FAILURES,
  WORK_KINDS,
  type WorkRef,
} from "../auto-review/work.js";
import { errorName, logError } from "../log.js";
import { CODE_PLATFORMS } from "../shared/index.js";
import { type Machine, run } from "./review-runner.js";

// A remote runner (docs/runner.md): asks the server for the next hosted job
// (src/auto-review/runner-api.ts), runs it on this machine and reports how
// it went. It only calls out, so it needs no address of its own, and holds
// nothing but its token: each job brings its own credentials.

export type RunnerOptions = Machine & {
  /** The server's address, as people open it. */
  server: string;
  token: string;
  /** How the console names this runner. */
  name: string;
  version: string;
  /** How long it waits before asking again when there was no job. */
  pollMs?: number;
  fetch?: typeof fetch;
};

const POLL_MS = 20_000;
/** A server that cannot be reached is asked again later, up to this far apart. */
const MAX_BACKOFF_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
/** A lost answer must not leave a finished job running until its lease lapses. */
const SETTLE_TRIES = 5;

const assignment = z.object({
  kind: z.enum(WORK_KINDS),
  id: z.string(),
  accountId: z.string(),
  attempts: z.number().int(),
  leaseUntil: z.coerce.date(),
  repo: z.object({ platform: z.enum(CODE_PLATFORMS), url: z.url(), fullName: z.string() }),
  bot: z
    .object({ token: z.string(), login: z.string().optional() })
    .transform(({ token, login }) => ({ token, ...(login ? { login } : {}) })),
  cloudUrl: z.url(),
  credentials: z.record(z.string(), z.union([z.string(), z.number()])),
  args: z.array(z.string()),
  config: z.record(z.string(), z.unknown()),
  ok: z.array(z.number().int()),
  settled: z.array(z.number().int()),
});
const claimed = z.object({ assignment: assignment.nullable() });

const sleep = (ms: number, stop: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (stop.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener("abort", done, { once: true });
  });

/** Takes and runs jobs until `stop` aborts; a job running then is ended and reported failed, to be retried. */
export async function runRunner(options: RunnerOptions, stop: AbortSignal): Promise<void> {
  const call = async (path: string, body: unknown) => {
    const res = await (options.fetch ?? fetch)(new URL(`/api/runner/${path}`, options.server), {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`runner_${path}_${res.status}`);
    }
    return res.json();
  };
  const settle = async (ref: WorkRef, failure: (typeof RUN_FAILURES)[number] | null) => {
    for (let tries = 1; ; tries++) {
      try {
        return await call("settle", { ...ref, failure });
      } catch (e) {
        if (tries === SETTLE_TRIES) throw e;
        await sleep(2_000 * tries, new AbortController().signal);
      }
    }
  };
  const pollMs = options.pollMs ?? POLL_MS;
  let backoff = pollMs;
  while (!stop.aborted) {
    try {
      const { assignment: work } = claimed.parse(
        await call("claim", { name: options.name, version: options.version }),
      );
      backoff = pollMs;
      if (!work) {
        await sleep(pollMs, stop);
        continue;
      }
      const { kind, id, accountId, attempts } = work;
      console.log(JSON.stringify({ level: "info", event: "runner_job_started", kind, job: id }));
      const failure = await run(options, work satisfies Assignment, new Date(), stop);
      await settle({ kind, id, accountId, attempts }, failure);
      console.log(
        JSON.stringify({ level: "info", event: "runner_job_ended", kind, job: id, failure }),
      );
    } catch (e) {
      logError("runner_failed", { error: errorName(e), retryInMs: backoff });
      await sleep(backoff, stop);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}
