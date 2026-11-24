import { audit } from "../audit.js";
import { repoIdentity } from "../platforms/platform.js";
import { openAtHead } from "../pull-open-findings.js";
import { MAX_DAILY_FIX_REQUESTS, MAX_MEND_REQUEST } from "../shared/index.js";
import { type Answer, headOf, type Run, short, UNREAD } from "./commands.js";
import { FIXING_LABEL, unlabelIdle } from "./fix-label.js";
import { MEND_DEBOUNCE_MS } from "./mend-round.js";

// `@ocra fix` and `@ocra stop`: the pull request's fix loop (./mend-work.ts)
// asked for and stopped from a comment, as the console's Fix with ocra does.
// The loop commits only where the account lets the bot commit to the
// repository; each commit's note says how to undo it.

const STOP_HINT = "`@ocra stop` stops it.";

/** Asks the loop to fix the open findings of the head that the judge kept. */
export async function fix(run: Run, number: number): Promise<Answer> {
  const { data, platform, bot, repo } = run;
  if (repo.mend !== "commit") {
    return {
      ok: true,
      text: `ocra does not commit fixes to this repository yet: an admin turns on its Fixes on [Auto review](${run.consoleUrl}/auto-review), and \`@ocra fix\` then commits them.`,
    };
  }
  const head = await headOf(run, number);
  if (!head) return UNREAD;
  const { open } = await openAtHead(data, {
    prRepository: repoIdentity(platform, repo.fullName),
    prNumber: number,
    prHeadSha: head,
  });
  const kept = open.filter((f) => !f.lowConfidence);
  if (kept.length === 0) {
    return { ok: true, text: `ocra has no open findings on ${short(head)} to fix.` };
  }
  const now = new Date();
  const { queued, limited } = await data.mends.request(
    { reviewRepoId: repo.id, number },
    kept.slice(0, MAX_MEND_REQUEST).map((f) => ({ findingId: f.id, fingerprint: f.fingerprint })),
    MAX_DAILY_FIX_REQUESTS,
    new Date(now.getTime() + MEND_DEBOUNCE_MS),
    now,
  );
  if (queued === 0) {
    return limited
      ? { ok: false, text: "ocra has used today's fixes for this account; ask again tomorrow." }
      : { ok: true, text: `Fixes for the open findings on ${short(head)} were asked for already.` };
  }
  await audit(data, "pull.mend_requested", {
    pull: `${repo.fullName}#${number}`,
    findings: queued,
  });
  run.service.kick();
  const labeled = await platform.actions.addLabels(bot.token, repo.fullName, number, [
    FIXING_LABEL,
  ]);
  if (labeled === "done") await data.mends.labeled(repo.id, number);
  const left = kept.length - MAX_MEND_REQUEST;
  const more = limited
    ? " Today's fixes ran out before the rest."
    : left > 0
      ? ` ${left} more wait for another \`@ocra fix\`.`
      : "";
  return {
    ok: true,
    text: `Fixing ${queued} open ${queued === 1 ? "finding" : "findings"} on ${short(head)}: ocra commits the fixes to the branch, each commit with a note on how to undo it.${more} ${STOP_HINT}`,
  };
}

/** Stops the loop: a round that waits does not run, one under way is the last. */
export async function stop(run: Run, number: number): Promise<Answer> {
  const { data, platform, bot, repo } = run;
  const stopped = await data.mends.stop(repo.id, number, new Date());
  if (stopped === "stopped") {
    await unlabelIdle(data, {
      platform,
      token: bot.token,
      fullName: repo.fullName,
      reviewRepoId: repo.id,
      number,
    });
  }
  const text = {
    stopped:
      "Stopped: ocra runs no more fix rounds on this pull request. `@ocra fix` starts them again.",
    stopping:
      "Stopping: the round under way finishes and commits what it fixed, and ocra runs none after it. `@ocra fix` starts them again.",
    idle: "ocra is not fixing this pull request.",
  }[stopped];
  return { ok: true, text };
}
