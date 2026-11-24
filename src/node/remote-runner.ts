import { z } from "zod";
import {
  ANSWERED_KINDS,
  type Assignment,
  type RUN_FAILURES,
  WORK_KINDS,
  type WorkRef,
} from "../auto-review/work.js";
import type { GraphAssignment } from "../graph/runner-api.js";
import { errorName, logError } from "../log.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { CODE_PLATFORMS } from "../shared/index.js";
import type { RestackAssignment } from "../stack-merge/restack-work.js";
import { spawnExec } from "./checkout.js";
import { type GraphMachine, runGraphBuild } from "./graph-job.js";
import type { GitRead } from "./local-graph.js";
import { runRestack } from "./restack-run.js";
import { type Machine, run, runAnswered } from "./review-runner.js";
import { serverGraphs } from "./runner-graphs.js";

// A remote runner (docs/runner.md): asks the server for the next hosted job
// (src/auto-review/runner-api.ts), runs it on this machine and reports how
// it went. It only calls out, so it needs no address of its own, and holds
// nothing but its token: each job brings its own credentials. When no job
// is due it builds the next code graph the server queued, where the server
// keeps them (src/graph/runner-api.ts).

export type RunnerOptions = Omit<Machine, "keptGraphs"> & {
  /** How git objects are read for a code graph; git itself by default. */
  git?: GitRead;
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

// A job waits half of this on average before it starts; an empty answer
// costs the server a few indexed lookups.
const POLL_MS = 5_000;
/** A server that cannot be reached is asked again later, up to this far apart. */
const MAX_BACKOFF_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
/** A lost answer must not leave a finished job running until its lease lapses. */
const SETTLE_TRIES = 5;

const claim = {
  id: z.string(),
  accountId: z.string(),
  attempts: z.number().int(),
  leaseUntil: z.coerce.date(),
  repo: z.object({ platform: z.enum(CODE_PLATFORMS), url: z.url(), fullName: z.string() }),
  bot: z
    .object({ token: z.string(), login: z.string().optional() })
    .transform(({ token, login }) => ({ token, ...(login ? { login } : {}) })),
};
const flag = z.string().regex(/^--[a-z][a-z-]{0,40}$/);
const assignment = z
  .object({
    ...claim,
    kind: z.enum(WORK_KINDS),
    cloudUrl: z.url(),
    credentials: z.record(z.string(), z.union([z.string(), z.number()])),
    uploadSalt: z.string().regex(/^[0-9a-f]{64}$/),
    args: z.array(z.string()),
    config: z.record(z.string(), z.unknown()),
    ok: z.array(z.number().int()),
    settled: z.array(z.number().int()),
    graph: z.object({ repoId: z.string(), pull: z.number().int() }).optional(),
    // What the server sends here reaches the CLI's command line: a flag, never a value.
    answered: z
      .object({
        flag: flag.optional(),
        // A round over failed checks or conflicts alone brings no input.
        input: z.unknown().optional(),
        more: z
          .array(z.object({ flag, input: z.unknown() }))
          .max(4)
          .optional(),
        switches: z.array(flag).max(4).optional(),
      })
      .transform(({ flag, input, more, switches }) => ({
        ...(flag !== undefined ? { flag } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(more ? { more } : {}),
        ...(switches ? { switches } : {}),
      }))
      .optional(),
  })
  .transform(({ graph, answered, ...work }) => ({
    ...work,
    ...(graph ? { graph } : {}),
    ...(answered ? { answered } : {}),
  }));
const graphBuild = z.object({
  ...claim,
  graphRepoId: z.string(),
  commit: z.string().regex(COMMIT_ID),
});
const branch = z.string().min(1).max(250);
const restackJob = z.object({
  ...claim,
  restack: z.object({
    branch,
    head: z.string().regex(COMMIT_ID),
    onto: z.object({ branch, commit: z.string().regex(COMMIT_ID).nullable() }),
    upstream: z.string().regex(COMMIT_ID),
    fork: z.boolean().default(false),
  }),
});
const claimed = z.object({
  assignment: assignment.nullable(),
  graph: graphBuild.optional(),
  restack: restackJob.optional(),
});

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
  const settle = (ref: WorkRef, failure: (typeof RUN_FAILURES)[number] | null) =>
    settleWith(call, "settle", { ...ref, failure });
  const graphs = serverGraphs(options.server, options.token, options.fetch);
  const machine = { ...options, graphs, keptGraphs: graphs };
  const pollMs = options.pollMs ?? POLL_MS;
  let backoff = pollMs;
  while (!stop.aborted) {
    try {
      const {
        assignment: work,
        graph,
        restack,
      } = claimed.parse(
        await call("claim", {
          name: options.name,
          version: options.version,
          graphs: true,
          restack: true,
          answers: ANSWERED_KINDS,
        }),
      );
      backoff = pollMs;
      if (!work) {
        if (restack) await runRestackJob(options, restack satisfies RestackAssignment, call, stop);
        else if (!graph) await sleep(pollMs, stop);
        else await buildGraph(machine, graph satisfies GraphAssignment, stop);
        continue;
      }
      const { kind, id, accountId, attempts } = work;
      console.log(JSON.stringify({ level: "info", event: "runner_job_started", kind, job: id }));
      let failure: (typeof RUN_FAILURES)[number] | null;
      if (work.answered) {
        const ran = await runAnswered(machine, work satisfies Assignment, new Date(), stop);
        await settleWith(call, "settle-answer", { kind, id, accountId, attempts, ran });
        failure = "failure" in ran ? ran.failure : null;
      } else {
        failure = await run(machine, work satisfies Assignment, new Date(), stop);
        await settle({ kind, id, accountId, attempts }, failure);
      }
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

type Call = (path: string, body: unknown) => Promise<unknown>;

/** A lost answer must not leave a finished job running until its lease lapses: tried SETTLE_TRIES times. */
async function settleWith(call: Call, path: string, body: unknown) {
  for (let tries = 1; ; tries++) {
    try {
      return await call(path, body);
    } catch (e) {
      if (tries === SETTLE_TRIES) throw e;
      await sleep(2_000 * tries, new AbortController().signal);
    }
  }
}

async function runRestackJob(
  options: RunnerOptions,
  work: RestackAssignment,
  call: Call,
  stop: AbortSignal,
) {
  const event = { kind: "restack", job: work.id };
  console.log(JSON.stringify({ level: "info", event: "runner_job_started", ...event }));
  const result = await runRestack(options.exec ?? spawnExec, work, new Date(), stop);
  const { id, accountId, attempts } = work;
  await settleWith(call, "settle-restack", { id, accountId, attempts, result });
  const failure = "failure" in result ? result.failure : null;
  const outcome = "outcome" in result ? result.outcome : null;
  console.log(
    JSON.stringify({ level: "info", event: "runner_job_ended", ...event, failure, outcome }),
  );
}

async function buildGraph(machine: GraphMachine, build: GraphAssignment, stop: AbortSignal) {
  const event = { kind: "graph", job: build.id };
  console.log(JSON.stringify({ level: "info", event: "runner_job_started", ...event }));
  const failure = await runGraphBuild(machine, build, new Date(), stop);
  console.log(JSON.stringify({ level: "info", event: "runner_job_ended", ...event, failure }));
}
