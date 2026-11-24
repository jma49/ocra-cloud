import { redactField } from "@open-cr-agent/cloud-contract";
import { unlabelJob } from "./fix-label.js";
import { settleFixAnswer } from "./fix-work.js";
import { settleMendAnswer } from "./mend-work.js";
import {
  ANSWERED_KINDS,
  type AnsweredKind,
  type RunFailure,
  settle,
  type WorkRef,
  type WorkSource,
} from "./work.js";

// Jobs whose run answers in one line of JSON on the CLI's stdout (an
// assignment's `answered`): the machine reads the line, whatever the kind,
// and the server checks it with the kind's own schema here. A kind is added
// to ANSWERED_KINDS (./work.ts) and given its settler below.

/**
 * How an answered run ended: the last line it printed, parsed as JSON, or
 * the failure to retry; with `detail`, the end of what it wrote to stderr.
 */
export type Answered = ({ answer: unknown } | { failure: RunFailure }) & { detail?: string };

/** The most of a run's stderr a runner sends, redacted on the machine (src/node/run-detail.ts). */
export const MAX_RUN_DETAIL = 602;

type Settler = (
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef,
  answer: unknown,
  now: Date,
) => Promise<void>;

const SETTLERS: Record<AnsweredKind, Settler> = { fix: settleFixAnswer, mend: settleMendAnswer };

export const isAnswered = (kind: string): kind is AnsweredKind =>
  (ANSWERED_KINDS as readonly string[]).includes(kind);

/**
 * Records how the answered job's run went, only while it is still this
 * attempt's; a fix loop left idle loses its label where the platforms are given.
 */
export async function settleAnswered(
  source: Pick<WorkSource, "db" | "dailyCalls"> & Partial<Pick<WorkSource, "platforms" | "bots">>,
  ref: WorkRef & { kind: AnsweredKind },
  ran: Answered,
  now: Date,
): Promise<void> {
  // Redacted again here: a remote runner's text is not trusted to have been.
  if (ran.detail) {
    const detail = redactField(ran.detail, MAX_RUN_DETAIL).text;
    console.log({
      level: "info",
      event: "answered_run_detail",
      job: ref.id,
      kind: ref.kind,
      detail,
    });
  }
  if ("failure" in ran) await settle(source, ref, ran.failure, now);
  else await SETTLERS[ref.kind](source, ref, ran.answer, now);
  if (ref.kind === "mend") await unlabelJob(source, ref.accountId, ref.id);
}
