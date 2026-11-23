import { api } from "../api.js";
import { type Budget, dailyLimit, resetsAt } from "../budget.js";
import { num } from "../format.js";
import { Link } from "../router.js";
import { useLoad } from "../ui.js";

// Hosted reviews make their model calls through the gateway: once the day's
// calls are used, the server leaves them queued, which this page would
// otherwise show as reviews that never start.

export function DailyLimitNotice() {
  const { data } = useLoad(() => api<Budget>("/budget"));
  if (!data || !(data.callsToday >= dailyLimit(data))) return null;
  const reset = resetsAt().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <p className="small daily-limit" role="status">
      <span className="badge badge-warn">Daily limit reached</span> All {num(dailyLimit(data))} of
      today's model calls are used. Queued reviews start when the limit resets at {reset}.{" "}
      <Link to="/budget">Budget</Link>
    </p>
  );
}
