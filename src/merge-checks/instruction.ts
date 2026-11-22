import { MAX_MERGE_CHECKS, type MergeCheck } from "@open-cr-agent/cloud-contract";
import { sha256Hex } from "../crypto.js";
import type { MergeCheckVerdictView } from "../shared/index.js";
import type { CheckConfig } from "./evaluate.js";
import { settingsOf } from "./settings.js";

// Plain-language checks (the engine's ADR-0054): the hosted review is given
// each enabled one under an id of its row and its text, and judges it; a
// verdict counts only under the id of the text the check has now, so an
// edit waits for a review of the new text.

/** The id the review knows the check by: a new one whenever its text changes. */
export async function instructionCheckId(rowId: string, text: string): Promise<string> {
  return `${rowId}.${(await sha256Hex(text)).slice(0, 12)}`;
}

/** The enabled plain-language checks, as the review's configuration lists them. */
export async function engineMergeChecks(checks: readonly CheckConfig[]): Promise<MergeCheck[]> {
  const out: MergeCheck[] = [];
  for (const check of checks) {
    if (check.kind !== "instruction" || check.mode === "off") continue;
    const settings = settingsOf("instruction", check.settings);
    if (!settings) continue;
    out.push({ id: await instructionCheckId(check.id, settings.text), instruction: settings.text });
  }
  return out.slice(0, MAX_MERGE_CHECKS);
}

/** The checks with the id the head's review was to judge each plain-language one by. */
export async function withEngineIds(checks: readonly CheckConfig[]): Promise<CheckConfig[]> {
  return Promise.all(
    checks.map(async (check) => {
      const settings = check.kind === "instruction" && settingsOf("instruction", check.settings);
      return settings
        ? { ...check, engineId: await instructionCheckId(check.id, settings.text) }
        : check;
    }),
  );
}

type Judged = { outcome: "passed" | "failed" | "not_evaluated"; detail: string };

/** One line of at most this many characters of the review's reason. */
const MAX_REASON = 300;

const reasonOf = (verdict: NonNullable<MergeCheckVerdictView>) => {
  const line = verdict.reason?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
};

/** The check's outcome from the verdicts of the head's review (undefined when it judged none). */
export function judgeInstruction(
  engineId: string | undefined,
  verdicts: readonly MergeCheckVerdictView[] | undefined,
): Judged {
  const verdict = engineId && verdicts?.find((v) => v?.id === engineId);
  if (!verdict) {
    return {
      outcome: "not_evaluated",
      detail: "not evaluated yet: no ocra review of this head judged this instruction",
    };
  }
  const reason = reasonOf(verdict);
  switch (verdict.outcome) {
    case "passed":
      return { outcome: "passed", detail: reason ?? "the change follows the instruction" };
    case "failed":
      return { outcome: "failed", detail: reason ?? "the change does not follow the instruction" };
    default:
      return {
        outcome: "not_evaluated",
        detail: `not evaluated: the review could not tell${reason ? ` (${reason})` : ""}`,
      };
  }
}
