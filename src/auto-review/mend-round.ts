import { SEVERITIES } from "@open-cr-agent/cloud-contract";
import type { Row, Scoped } from "../db/scoped.js";
import { findingInput } from "../findings.js";
import type { AnsweredRun } from "./work.js";

// What a round of a pull request's fix loop (./mend-work.ts) is given: the
// findings that wait for it and the state the last round printed.

/** Clicks in a row on one pull request share a round, and so a commit. */
export const MEND_DEBOUNCE_MS = 15_000;

/**
 * Findings a round is given: it works on a few (the engine's cap) and puts
 * the others off, which the next round takes.
 */
const MAX_ROUND_FINDINGS = 20;

/** Why a round ran nothing, as the loop's `error` says. */
const MEND_SKIPS = ["switched_off", "nothing_waiting", "stopped"] as const;

/**
 * What the loop's next round reads, as files `ocra mend` is given (the
 * findings that wait, the most severe first, and the state the last round
 * printed, `--checks` when the head's failed checks wait too, and
 * `--conflicts` where the repository lets the bot merge its base branch), or why
 * it has none to run: `@ocra stop` came during the last round, the
 * repository's level is no longer `commit`, or nothing waits.
 */
export async function mendInput(
  data: Scoped,
  jobId: string,
  repo: Row<"reviewRepos">,
): Promise<AnsweredRun | (typeof MEND_SKIPS)[number]> {
  const job = await data.get("mendJobs", jobId);
  if (job?.stop) return "stopped";
  // A suggestion writes nothing, so the repository's level does not hold it back; findings wait for a round that commits.
  if (job?.suggest && job.conflicts) {
    return {
      more: job.loop ? [{ flag: "--state", input: job.loop }] : [],
      switches: ["--conflicts"],
    };
  }
  if (repo.mend !== "commit") return "switched_off";
  const waiting = job ? await data.mends.waitingFindings(job.id, MAX_ROUND_FINDINGS) : [];
  // A finding decided since it was asked for needs no fix.
  const open = waiting.filter((f) => f.status === "open");
  const checks = job?.checks === true && repo.mendChecks;
  // A person asked for the conflicts: a round runs for them alone.
  const conflicts = job?.conflicts === true && repo.mendConflicts;
  if (!job || (open.length === 0 && !checks && !conflicts)) return "nothing_waiting";
  const switches = [
    ...(checks ? ["--checks"] : []),
    ...(repo.mendConflicts ? ["--conflicts"] : []),
  ];
  const rank = (f: Row<"findings">) => SEVERITIES.indexOf(f.severity);
  return {
    ...(open.length > 0
      ? { flag: "--findings", input: open.sort((a, b) => rank(a) - rank(b)).map(findingInput) }
      : {}),
    more: job.loop ? [{ flag: "--state", input: job.loop }] : [],
    ...(switches.length > 0 ? { switches } : {}),
  };
}
