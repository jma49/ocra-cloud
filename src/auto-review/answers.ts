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

/** How an answered run ended: the last line it printed, parsed as JSON, or the failure to retry. */
export type Answered = { answer: unknown } | { failure: RunFailure };

type Settler = (
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef,
  answer: unknown,
  now: Date,
) => Promise<void>;

const SETTLERS: Record<AnsweredKind, Settler> = { fix: settleFixAnswer, mend: settleMendAnswer };

export const isAnswered = (kind: string): kind is AnsweredKind =>
  (ANSWERED_KINDS as readonly string[]).includes(kind);

/** Records how the answered job's run went, only while it is still this attempt's. */
export function settleAnswered(
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef & { kind: AnsweredKind },
  ran: Answered,
  now: Date,
): Promise<void> {
  if ("failure" in ran) return settle(source, ref, ran.failure, now);
  return SETTLERS[ref.kind](source, ref, ran.answer, now);
}
