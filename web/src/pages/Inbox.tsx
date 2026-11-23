import InboxIcon from "lucide-react/icons/inbox";
import Plug from "lucide-react/icons/plug";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago } from "../format.js";
import { useCollapsed } from "../inbox/collapsed.js";
import { inboxCommands } from "../inbox/commands.js";
import { KeyHints } from "../inbox/key-hints.js";
import { rememberQueue } from "../inbox/queue.js";
import { PullRow } from "../inbox/row.js";
import { SectionMenu } from "../inbox/section-menu.js";
import {
  type Filters,
  type InboxAnswer,
  inboxSections,
  reposOf,
  reviewAsked,
  rowsOf,
  type ShownSection,
  stackRun,
} from "../inbox/sections.js";
import { useUnreadMarks } from "../inbox/unread.js";
import { ViewDrawer } from "../inbox/view-drawer.js";
import { forgetSharedView, sharedView, usePullViews, type ViewDraft } from "../inbox/views.js";
import { useListCursor } from "../list-cursor.js";
import { usePageCommands } from "../page-commands.js";
import { platformsText } from "../platform-names.js";
import { pullPath } from "../pull/path.js";
import { Link, navigate } from "../router.js";
import { useTitleCount } from "../title.js";
import { EmptyState, LoadError, Loading, PageHead } from "../ui.js";

type Editing = { draft: ViewDraft; view?: PullView };
const BLANK: ViewDraft = { name: "", filters: { roles: ["author"], states: ["open"] } };

/** A list read a while ago may show a pull request as it was then, not as it is. */
const readBefore = (at: number | undefined) =>
  at !== undefined && Date.now() - at > 60_000
    ? `This list was read ${ago(new Date(at).toISOString())}.`
    : "";

export function Inbox() {
  const { data, error, reload, stale, change, readAt } = useCached("/platforms/pulls", () =>
    api<InboxAnswer>("/platforms/pulls"),
  );
  const views = usePullViews();
  const marks = useUnreadMarks(change);
  const [filters, setFilters] = useState<Filters>({ text: "", repo: "" });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [offered, setOffered] = useState(() => sharedView(location.search));
  const [failed, setFailed] = useState<unknown>(null);
  const { collapsed, toggle } = useCollapsed();
  const finder = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (data ? rowsOf(data) : []), [data]);
  const sections = useMemo(
    () => inboxSections(rows, filters, views.views),
    [rows, filters, views.views],
  );
  const visible = sections.flatMap((s) => (collapsed.has(s.key) ? [] : s.rows));
  const cursor = useListCursor(visible.length, list, true);
  useTitleCount(useMemo(() => reviewAsked(rows), [rows]));
  const hidden = views.views.filter((v) => v.hidden);
  const unread = useMemo(() => rows.filter((r) => r.unread), [rows]);
  const arrange = (change: Promise<unknown>) => {
    setFailed(null);
    change.catch(setFailed);
  };

  useEffect(() => {
    rememberQueue(visible.map((r) => pullPath(r.platform, r.repo, r.number)));
  });

  const open = (r = visible[cursor.current]) => {
    if (!r) return;
    marks.opened(r);
    navigate(pullPath(r.platform, r.repo, r.number));
  };
  const commands = inboxCommands({
    row: visible[cursor.current],
    move: cursor.move,
    open,
    find: () => finder.current?.focus(),
    refresh: reload,
    toggleRead: (r) => marks.mark([r], r.unread),
    markAllRead: unread.length > 0 ? () => marks.mark(unread, true) : null,
    newSection: () => setEditing({ draft: BLANK }),
  });
  usePageCommands("This inbox", commands);

  const filter = (change: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...change }));
    cursor.reset();
  };
  const filtering = Boolean(filters.text || filters.repo);
  const dismissOffer = () => {
    forgetSharedView();
    setOffered(null);
  };
  let index = 0;

  return (
    <>
      <PageHead
        title="Pull requests"
        sub="What waits on you across every connected platform, read live."
        actions={
          <Button type="button" variant="outline" onClick={() => setEditing({ draft: BLANK })}>
            New section
          </Button>
        }
      />
      {offered && (
        <div className="note" role="status">
          <span className="grow">Someone shared the section “{offered.name}” with you.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing({ draft: offered });
              dismissOffer();
            }}
          >
            Add it
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={dismissOffer}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="inbox-tools">
        <input
          ref={finder}
          type="search"
          className="input"
          placeholder="Find by repository, title or author"
          aria-label="Find"
          value={filters.text}
          onChange={(e) => filter({ text: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
        <label>
          Repository{" "}
          <select
            className="input"
            value={filters.repo}
            onChange={(e) => filter({ repo: e.target.value })}
          >
            <option value="">All</option>
            {reposOf(rows).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small grow" role="status">
          {data && stale ? `Refreshing… ${readBefore(readAt)}` : ""}
        </span>
        {unread.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => marks.mark(unread, true)}
          >
            Mark all read
          </Button>
        )}
      </div>
      {error && data ? (
        <p className="error small row-gap inbox-old" role="alert">
          <span className="grow">
            Could not refresh: {why(error)}. {readBefore(readAt)}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </p>
      ) : null}
      <PlatformNotes data={data} retry={reload} />
      {error && !data ? (
        <LoadError what="pull requests" error={error} retry={reload} />
      ) : !data || !views.ready ? (
        <Loading what="pull requests" />
      ) : !data.platforms.some((p) => p.linked) ? (
        <div className="section card">
          <EmptyState
            icon={Plug}
            title="Connect a platform"
            action={
              <Button variant="outline" render={<Link to="/repositories" />}>
                Connect under Repositories
              </Button>
            }
          >
            Link {platformsText(data.platforms.map((p) => p.platform))} to see the pull requests
            that wait on you.
          </EmptyState>
        </div>
      ) : sections.every((s) => s.rows.length === 0) ? (
        <div className="section card">
          <EmptyState
            icon={InboxIcon}
            title={<>{filtering ? "No pull request matches" : "Nothing waits on you"}</>}
          >
            {filtering
              ? "Clear the search or the repository to see every section."
              : "Pull requests asking your review, and your own open ones, appear here."}
          </EmptyState>
        </div>
      ) : (
        <div ref={list} className="inbox-sections card">
          {sections.map((s, place) => (
            <Section
              key={s.key}
              s={s}
              open={!collapsed.has(s.key)}
              toggle={() => toggle(s.key)}
              menu={
                <SectionMenu
                  title={s.title}
                  edit={() => setEditing({ draft: s.view, view: s.view })}
                  up={place > 0 ? () => arrange(views.move(s.view, -1)) : undefined}
                  down={
                    place < sections.length - 1 ? () => arrange(views.move(s.view, 1)) : undefined
                  }
                  hide={() => arrange(views.setHidden(s.view, true))}
                  markRead={
                    s.rows.some((r) => r.unread) ? () => marks.mark(s.rows, true) : undefined
                  }
                />
              }
            >
              {!collapsed.has(s.key) &&
                s.rows.map((r, at) => {
                  const i = index++;
                  return (
                    <PullRow
                      key={`${r.host}:${r.id}`}
                      r={r}
                      i={i}
                      current={i === cursor.current}
                      run={stackRun(s.rows, at)}
                      onOpen={() => marks.opened(r)}
                      onMark={(read) => marks.mark([r], read)}
                    />
                  );
                })}
            </Section>
          ))}
        </div>
      )}
      {data && views.ready && <KeyHints commands={commands} />}
      {hidden.length > 0 && (
        <p className="inbox-hidden muted small">
          Hidden:
          {hidden.map((v) => (
            <Button
              key={v.id}
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Show ${v.name}`}
              onClick={() => arrange(views.setHidden(v, false))}
            >
              {v.name}
            </Button>
          ))}
        </p>
      )}
      {failed !== null && (
        <p className="error" role="alert">
          Could not change the sections: {why(failed)}.
        </p>
      )}
      {marks.failed !== null && (
        <p className="error" role="alert">
          Could not mark the pull requests: {why(marks.failed)}.
        </p>
      )}
      {editing && (
        <ViewDrawer
          initial={editing.draft}
          repos={reposOf(rows)}
          editing={Boolean(editing.view)}
          onSave={(draft) => (editing.view ? views.save(editing.view, draft) : views.add(draft))}
          {...(editing.view && { onDelete: () => views.remove(editing.view as PullView) })}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function Section(props: {
  s: ShownSection;
  open: boolean;
  toggle: () => void;
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  const { s } = props;
  return (
    <section className={`inbox-group${s.rows.length ? "" : " is-empty"}`} aria-label={s.title}>
      <div className="inbox-group-head">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={props.open}
          onClick={props.toggle}
        >
          <span className="fold" aria-hidden="true" />
          <h2>{s.title}</h2>
          <span className="count">{s.rows.length}</span>
        </button>
        {props.menu}
      </div>
      {props.open && props.children}
    </section>
  );
}

function PlatformNotes(props: { data: InboxAnswer | undefined; retry: () => void }) {
  const platforms = props.data?.platforms ?? [];
  return (
    <>
      {platforms
        .filter((p) => p.failed)
        .map((p) => (
          <p key={p.host} className="error" role="alert">
            Could not read pull requests from {p.host}.{" "}
            <Button type="button" variant="outline" size="sm" onClick={props.retry}>
              Try again
            </Button>
          </p>
        ))}
      {platforms
        .filter((p) => !p.linked && platforms.some((q) => q.linked))
        .map((p) => (
          <p key={p.host} className="muted small">
            {p.host} is not connected. <Link to="/repositories">Connect it under Repositories</Link>
            .
          </p>
        ))}
      {platforms.some((p) => p.more) && (
        <p className="muted small">
          Showing the 50 most recently updated open pull requests of each list.
        </p>
      )}
    </>
  );
}
