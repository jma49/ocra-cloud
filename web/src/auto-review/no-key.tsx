import { Button } from "@/components/ui/button";
import { loadKeys } from "../account-keys.js";
import { Link } from "../router.js";
import { useLoad } from "../ui.js";

// Hosted reviews call models with the account's own keys: without one, every
// review this page queues would fail, so the page says so before it is used.

export function NoKeyNotice() {
  const { data } = useLoad(loadKeys);
  if (!data || data.keys.length > 0) return null;
  return (
    <div className="note row-gap no-key-note" role="status">
      <span className="grow">
        Reviews run on your own model key, and you have none yet. Add one first, or the reviews
        queued here fail.
      </span>
      <Button size="sm" render={<Link to="/keys" />}>
        Add a key
      </Button>
    </div>
  );
}
