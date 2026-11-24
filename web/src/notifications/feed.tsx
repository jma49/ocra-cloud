import Bell from "lucide-react/icons/bell";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  FEED_DAYS,
  FEED_UNREAD_CAP,
  type FeedItemView,
  type FeedPageView,
  type FeedUnreadView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Drawer } from "../drawer.js";
import { count, since, time } from "../format.js";
import { Link } from "../router.js";
import { ActionError, EmptyNote, LoadError, Loading, useAction, usePoll } from "../ui.js";

// The console's notification centre: a bell on the rail that counts what is
// unread, and the notices themselves in a drawer, each opening its page.

const POLL_MS = 60_000;

/** "3 unread", and "99+ unread" where the count stops. */
const unreadText = (unread: number) =>
  unread >= FEED_UNREAD_CAP ? `${FEED_UNREAD_CAP - 1}+ unread` : count(unread, "unread", "unread");

/** Notices in a row that say the same of the same pull request, as one with how many it holds. */
type Run = { item: FeedItemView; ids: string[] };

function runsOf(items: readonly FeedItemView[]): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    const same =
      last &&
      item.pull != null &&
      last.item.pull === item.pull &&
      last.item.repo === item.repo &&
      last.item.title === item.title &&
      last.item.subtitle === item.subtitle;
    if (same) {
      last.ids.push(item.id);
      if (!item.read && last.item.read) last.item = { ...last.item, read: false };
    } else runs.push({ item, ids: [item.id] });
  }
  return runs;
}

const UNREAD_ONLY = "ocra.feed-unread-only";
const readUnreadOnly = () => {
  try {
    return localStorage.getItem(UNREAD_ONLY) === "1";
  } catch {
    return false;
  }
};

function Notice(props: { run: Run; open: (run: Run) => void }) {
  const { item } = props.run;
  const times = props.run.ids.length;
  const where = [item.repo, item.pull != null && `#${item.pull}`].filter(Boolean).join(" ");
  return (
    <li>
      <Link
        to={item.link}
        className={item.read ? "feed-item" : "feed-item unread"}
        onClick={() => props.open(props.run)}
      >
        <span className="feed-title">
          {!item.read && <span className="sr-only">Unread: </span>}
          {item.title}
        </span>
        {item.subtitle && <span className="feed-subtitle">{item.subtitle}</span>}
        <span className="feed-meta subtle small">
          {where && <span className="mono">{where}</span>}
          {times > 1 && <span>{times} times</span>}
          <time dateTime={item.at} title={time(item.at)}>
            {since(item.at)}
          </time>
        </span>
      </Link>
    </li>
  );
}

function FeedDrawer(props: { onClose: () => void; onUnread: (unread: number) => void }) {
  const { onUnread } = props;
  const [items, setItems] = useState<FeedItemView[]>();
  const [next, setNext] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(readUnreadOnly);
  const pickUnreadOnly = (on: boolean) => {
    setUnreadOnly(on);
    try {
      localStorage.setItem(UNREAD_ONLY, on ? "1" : "0");
    } catch {}
  };
  const tell = useCallback(
    (n: number) => {
      setUnread(n);
      onUnread(n);
    },
    [onUnread],
  );
  const page = useAction(async (before?: string) => {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    const answer = await api<FeedPageView>(`/notifications/feed${query}`);
    setItems((had) => (before && had ? [...had, ...answer.items] : answer.items));
    setNext(answer.next);
    tell(answer.unread);
  });
  const read = useAction(async (body: { ids: string[] } | { before: string }) => {
    const answer = await api<FeedUnreadView>("/notifications/feed/read", {
      method: "POST",
      body: JSON.stringify(body),
    });
    tell(answer.unread);
    return answer;
  });
  const { run: load } = page;
  useEffect(() => {
    void load();
  }, [load]);

  const open = (run: Run) => {
    if (!run.item.read) void read.run({ ids: run.ids });
    props.onClose();
  };
  const runs = runsOf((items ?? []).filter((i) => !unreadOnly || !i.read));
  const readAll = async () => {
    const newest = items?.[0];
    if (!newest || !(await read.run({ before: newest.at }))) return;
    setItems((had) => had?.map((i) => ({ ...i, read: true })));
  };

  return (
    <Drawer
      title="Notifications"
      heading={
        <>
          Notifications
          {unread > 0 && <span className="feed-unread subtle small">{unreadText(unread)}</span>}
        </>
      }
      onClose={props.onClose}
      foot={
        <>
          <label className="check small grow">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => pickUnreadOnly(e.target.checked)}
            />
            Unread only
          </label>
          {unread > 0 && (
            <Button type="button" variant="outline" disabled={read.busy} onClick={readAll}>
              Mark all read
            </Button>
          )}
        </>
      }
    >
      {read.error != null && <ActionError what="mark them read" error={read.error} />}
      {!items ? (
        page.error ? (
          <LoadError what="notifications" error={page.error} retry={() => void load()} inCard />
        ) : (
          <Loading what="notifications" rows={5} inCard />
        )
      ) : items.length > 0 && runs.length === 0 ? (
        <EmptyNote>Nothing unread.</EmptyNote>
      ) : items.length === 0 ? (
        <EmptyNote>
          Nothing yet. Review requests, comments, mentions and finished reviews show here, and stay
          for {FEED_DAYS} days.
        </EmptyNote>
      ) : (
        <>
          <ul className="feed-list">
            {runs.map((run) => (
              <Notice key={run.item.id} run={run} open={open} />
            ))}
          </ul>
          {page.error != null && <ActionError what="load more" error={page.error} />}
          {next && (
            <Button
              type="button"
              variant="ghost"
              className="feed-more"
              disabled={page.busy}
              onClick={() => void load(next)}
            >
              Show earlier
            </Button>
          )}
        </>
      )}
    </Drawer>
  );
}

/**
 * The rail's bell. `tip` names it beside the rail as it does the rail's
 * links; a count that cannot be read shows none rather than a guess.
 */
export function FeedBell(props: { tip: (label: string, control: ReactElement) => ReactElement }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const check = useCallback(() => {
    api<FeedUnreadView>("/notifications/feed/unread").then(
      (answer) => setUnread(answer.unread),
      () => {},
    );
  }, []);
  useEffect(check, [check]);
  usePoll(!open, check, POLL_MS);
  const label = unread > 0 ? `Notifications, ${unreadText(unread)}` : "Notifications";
  return (
    <>
      {props.tip(
        "Notifications",
        <button
          type="button"
          className="rail-link feed-bell"
          aria-label={label}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Bell className="nav-icon" size={20} aria-hidden="true" />
          {unread > 0 && <span className="feed-dot" aria-hidden="true" />}
        </button>,
      )}
      {open && <FeedDrawer onClose={() => setOpen(false)} onUnread={setUnread} />}
    </>
  );
}
