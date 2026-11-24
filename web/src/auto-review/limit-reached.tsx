import { Status } from "@/components/status";
import { spendReached } from "../../../src/shared/index.js";
import { type Budget, dailyLimit, resetLabel } from "../budget/budget.js";
import { useRead } from "../cache.js";
import { num, usd } from "../format.js";
import { Link } from "../router.js";

// Hosted reviews wait while the account is at a limit: the day's gateway
// calls, or what its reviews may cost a day or a month. The server leaves
// them queued, which the pages would otherwise show as reviews that never
// start.

/** Which limit holds hosted reviews back, why, and when they start again. */
export type LimitReached = { badge: string; why: string; resumes: string };

export function limitReached(b: Budget, now = Date.now()): LimitReached | null {
  // A server from before spend limits, mid-deploy, answers without them.
  const spend = b.spend ? spendReached(b.spend) : null;
  if (spend) {
    const monthly = spend.window === "monthly";
    return {
      badge: monthly ? "Monthly spend limit reached" : "Daily spend limit reached",
      why: `Reviews cost ${usd(spend.spentUsd)} ${monthly ? "this month" : "today"}, of a ${usd(spend.limitUsd)} limit.`,
      resumes: `${monthly ? "on" : "at"} ${resetLabel(spend.window, now)}, when the limit resets, or once you raise it`,
    };
  }
  if (!(b.callsToday >= dailyLimit(b))) return null;
  return {
    badge: "Daily limit reached",
    why: `All ${num(dailyLimit(b))} of today's model calls are used.`,
    resumes: `at ${resetLabel("daily", now)}, when the limit resets`,
  };
}

/** The limit the account is at; null while hosted reviews may start. */
export function useLimitReached(): LimitReached | null {
  const { data } = useRead<Budget>("/budget");
  return data ? limitReached(data) : null;
}

export function LimitReachedNotice() {
  const reached = useLimitReached();
  if (!reached) return null;
  return (
    <p className="small limit-reached" role="status">
      <Status tone="warn">{reached.badge}</Status> {reached.why} Queued reviews start{" "}
      {reached.resumes}. <Link to="/budget">Budget</Link>
    </p>
  );
}
