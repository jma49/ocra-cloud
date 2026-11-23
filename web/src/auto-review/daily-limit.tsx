import { api } from "../api.js";
import { type Budget, dailyLimit, resetsAt } from "../budget.js";
import { num } from "../format.js";
import { Link } from "../router.js";
import { useLoad } from "../ui.js";

// Hosted reviews make their model calls through the gateway: once the day's
// calls are used, the server leaves them queued, which this page would
// otherwise show as reviews that never start.

/** The day's limit and when it resets, once every call of the day is used; null while calls are left. */
export function useDailyLimitReached(): { limit: number; reset: string } | null {
  const { data } = useLoad(() => api<Budget>("/budget"));
  if (!data || !(data.callsToday >= dailyLimit(data))) return null;
  const reset = resetsAt().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { limit: dailyLimit(data), reset };
}

export function DailyLimitNotice() {
  const reached = useDailyLimitReached();
  if (!reached) return null;
  return (
    <p className="small daily-limit" role="status">
      <span className="badge badge-warn">Daily limit reached</span> All {num(reached.limit)} of
      today's model calls are used. Queued reviews start when the limit resets at {reached.reset}.{" "}
      <Link to="/budget">Budget</Link>
    </p>
  );
}
