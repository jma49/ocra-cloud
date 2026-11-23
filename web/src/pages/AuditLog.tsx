import ScrollText from "lucide-react/icons/scroll-text";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AuditEventView, AuditKind, AuditPage } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { describe, KIND_GROUPS } from "../audit/describe.js";
import { period } from "../format.js";
import { EmptyState, LoadError, Loading, PageHead, Seg } from "../ui.js";

const RANGES = [7, 30, 90].map(period);
const DAY_MS = 86_400_000;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

type Filter = { days: number; kind: AuditKind | "" };
type Log = {
  filter: Filter;
  events: AuditEventView[];
  next: string | null;
  loading: boolean;
  error: unknown;
};

/** The log under a filter, a page at a time; a new filter starts from nothing. */
function useAuditLog(filter: Filter) {
  const [log, setLog] = useState<Log>({
    filter,
    events: [],
    next: null,
    loading: true,
    error: null,
  });
  const load = useCallback((f: Filter, after: string | null) => {
    const query = new URLSearchParams({ since: String(Date.now() - f.days * DAY_MS) });
    if (f.kind) query.set("kind", f.kind);
    if (after) query.set("after", after);
    setLog((l) =>
      l.filter === f
        ? { ...l, loading: true, error: null }
        : { filter: f, events: [], next: null, loading: true, error: null },
    );
    api<AuditPage>(`/audit?${query}`).then(
      // An answer for a filter that was left is dropped.
      (page) =>
        setLog((l) =>
          l.filter === f
            ? { ...l, events: [...l.events, ...page.events], next: page.next, loading: false }
            : l,
        ),
      (error) => setLog((l) => (l.filter === f ? { ...l, loading: false, error } : l)),
    );
  }, []);
  useEffect(() => load(filter, null), [filter, load]);
  return { ...log, more: () => load(log.filter, log.next), retry: () => load(log.filter, null) };
}

function byDay(events: AuditEventView[]): { day: string; events: AuditEventView[] }[] {
  const days: { day: string; events: AuditEventView[] }[] = [];
  for (const e of events) {
    const name = day(e.createdAt);
    const last = days.at(-1);
    if (last?.day === name) last.events.push(e);
    else days.push({ day: name, events: [e] });
  }
  return days;
}

export function AuditLog() {
  const [filter, setFilter] = useState<Filter>({ days: 30, kind: "" });
  const log = useAuditLog(filter);
  const first = log.events.length === 0;
  return (
    <>
      <PageHead
        title="Audit log"
        sub="What changed on your account and when. It never holds a key, a token or a message's text."
        actions={
          <div className="row-gap center wrap">
            <select
              className="input audit-kind"
              aria-label="Kind of event"
              value={filter.kind}
              onChange={(e) => setFilter({ ...filter, kind: e.target.value as AuditKind | "" })}
            >
              <option value="">Every kind of event</option>
              {KIND_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.kinds.map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Seg
              label="Time range"
              value={filter.days}
              options={RANGES}
              onChange={(days) => setFilter({ ...filter, days })}
            />
          </div>
        }
      />
      {first && log.error ? (
        <LoadError what="the audit log" error={log.error} retry={log.retry} />
      ) : first && log.loading ? (
        <Loading what="the audit log" />
      ) : first ? (
        <div className="card">
          <EmptyState
            icon={ScrollText}
            title={`${filter.kind ? "No such event" : "Nothing recorded"} in the last ${filter.days} days`}
          >
            Sign-ins, key changes and setting changes are listed here as they happen, and kept for
            90 days.
          </EmptyState>
        </div>
      ) : (
        <>
          {byDay(log.events).map((d, i) => (
            <section key={d.day} className={i === 0 ? "card" : "section card"} aria-label={d.day}>
              <div className="card-head">
                <h2>{d.day}</h2>
              </div>
              <ul className="audit-list">
                {d.events.map((e) => (
                  <li key={e.id}>
                    <time className="muted num" dateTime={e.createdAt}>
                      {clock(e.createdAt)}
                    </time>
                    <span>{describe(e)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {log.error ? (
            <p className="error" role="alert">
              Could not load more: {why(log.error)}.
            </p>
          ) : null}
          {log.next && (
            <div className="section">
              <Button variant="outline" loading={log.loading} onClick={log.more}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
