import { useEffect, useMemo, useRef, useState } from "react";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { useCollapsed } from "../inbox/collapsed.js";
import { useListKeys } from "../inbox/keys.js";
import { PullRow } from "../inbox/row.js";
import {
  type Filters,
  type InboxAnswer,
  inboxSections,
  reposOf,
  rowsOf,
} from "../inbox/sections.js";
import { Link } from "../router.js";
import { useTitleCount } from "../title.js";
import { LoadError, Loading, PageHead } from "../ui.js";

export function Inbox() {
  const { data, error, reload, stale } = useCached("/platforms/pulls", () =>
    api<InboxAnswer>("/platforms/pulls"),
  );
  const [filters, setFilters] = useState<Filters>({ text: "", repo: "" });
  const [at, setAt] = useState(0);
  const { collapsed, toggle } = useCollapsed();
  const finder = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (data ? rowsOf(data) : []), [data]);
  const sections = useMemo(() => inboxSections(rows, filters), [rows, filters]);
  const visible = sections.flatMap((s) => (collapsed.has(s.id) ? [] : s.rows));
  const current = Math.min(at, Math.max(visible.length - 1, 0));
  useTitleCount(sections.find((s) => s.id === "review")?.rows.length ?? 0);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  useListKeys({
    move: (step) =>
      setAt((a) =>
        Math.max(0, Math.min(visible.length - 1, Math.min(a, visible.length - 1) + step)),
      ),
    open: () => {
      const r = visible[current];
      if (r) window.open(r.url, "_blank", "noopener,noreferrer");
    },
    find: () => finder.current?.focus(),
    refresh: reload,
  });

  const filter = (change: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...change }));
    setAt(0);
  };
  const filtering = Boolean(filters.text || filters.repo);
  let index = 0;

  return (
    <>
      <PageHead
        title="Pull requests"
        sub="What waits on you across every connected platform, read live. j and k move, Enter opens, / finds, r refreshes."
      />
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
        <span className="muted small" role="status">
          {data && stale ? "Refreshing…" : ""}
        </span>
      </div>
      <PlatformNotes data={data} retry={reload} />
      {error && !data ? (
        <LoadError what="pull requests" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="pull requests" />
      ) : (
        <div ref={list} className="inbox-sections">
          {sections.map((s) => {
            const open = !collapsed.has(s.id);
            return (
              <section key={s.id} className="section card" aria-label={s.title}>
                <button
                  type="button"
                  className="card-head section-toggle"
                  aria-expanded={open}
                  onClick={() => toggle(s.id)}
                >
                  <h3>{s.title}</h3>
                  <span className="subtle small">{s.rows.length}</span>
                </button>
                {open &&
                  (s.rows.length === 0 ? (
                    <div className="empty">{filtering ? "None match." : s.empty}</div>
                  ) : (
                    s.rows.map((r) => {
                      const i = index++;
                      return (
                        <PullRow key={`${r.host}:${r.id}`} r={r} i={i} current={i === current} />
                      );
                    })
                  ))}
              </section>
            );
          })}
        </div>
      )}
      {error && data ? <p className="error">Could not refresh: {why(error)}.</p> : null}
    </>
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
            <button type="button" className="btn btn-sm" onClick={props.retry}>
              Try again
            </button>
          </p>
        ))}
      {platforms
        .filter((p) => !p.linked)
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
