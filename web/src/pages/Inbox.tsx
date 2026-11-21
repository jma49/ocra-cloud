import { useEffect, useMemo, useRef, useState } from "react";
import type { CodePlatformKind, PullItem, PullSection } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago } from "../format.js";
import { Link } from "../router.js";
import { LoadError, Loading, PageHead, Seg } from "../ui.js";

type PlatformPulls = {
  platform: CodePlatformKind;
  host: string;
  linked: boolean;
  failed: boolean;
  more: boolean;
  pulls: PullItem[];
};
type Answer = { platforms: PlatformPulls[] };
type Row = PullItem & { host: string };

type Shown = PullSection | "all";
const SECTIONS: { section: PullSection; title: string; empty: string }[] = [
  { section: "review", title: "Needs your review", empty: "No pull request asks your review." },
  { section: "authored", title: "Yours", empty: "You have no open pull requests." },
];

const CHECKS = {
  passing: { label: "Checks pass", cls: "badge-ok" },
  failing: { label: "Checks fail", cls: "badge-warn" },
  pending: { label: "Checks running", cls: "" },
} as const;
const REVIEW = {
  approved: { label: "Approved", cls: "badge-ok" },
  changes_requested: { label: "Changes requested", cls: "badge-warn" },
  required: { label: "Review required", cls: "" },
} as const;

export function inboxRows(answer: Answer, shown: Shown, text: string, drafts: boolean) {
  const needle = text.trim().toLowerCase();
  const all: Row[] = answer.platforms.flatMap((p) => p.pulls.map((r) => ({ ...r, host: p.host })));
  const keep = (r: Row) =>
    (drafts || !r.draft) &&
    (!needle ||
      `${r.repo}#${r.number} ${r.title} ${r.author ?? ""}`.toLowerCase().includes(needle));
  return SECTIONS.filter((s) => shown === "all" || shown === s.section).map((s) => ({
    ...s,
    rows: all.filter(
      (r) =>
        keep(r) &&
        r.sections.includes(s.section) &&
        (s.section === "review" || shown !== "all" || !r.sections.includes("review")),
    ),
  }));
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function Inbox() {
  const { data, error, reload, stale } = useCached("/platforms/pulls", () =>
    api<Answer>("/platforms/pulls"),
  );
  const [shown, setShown] = useState<Shown>("all");
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState(true);
  const [at, setAt] = useState(0);
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () => (data ? inboxRows(data, shown, text, drafts) : []),
    [data, shown, text, drafts],
  );
  const flat = sections.flatMap((s) => s.rows);
  const current = Math.min(at, Math.max(flat.length - 1, 0));

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const walk = useRef({ flat, current });
  walk.current = { flat, current };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && e.target === filter.current) {
        filter.current?.blur();
        return;
      }
      if (typing(e.target)) return;
      if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("a, button")) {
        return;
      }
      const { flat, current } = walk.current;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const step = e.key === "j" ? 1 : -1;
        const last = Math.max(flat.length - 1, 0);
        setAt((a) => Math.max(0, Math.min(last, Math.min(a, last) + step)));
      } else if ((e.key === "Enter" || e.key === "o") && flat[current]) {
        e.preventDefault();
        window.open(flat[current].url, "_blank", "noopener,noreferrer");
      } else if (e.key === "/") {
        e.preventDefault();
        filter.current?.focus();
      } else if (e.key === "r") {
        reload();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reload]);

  const unlinked = data?.platforms.filter((p) => !p.linked) ?? [];
  const failed = data?.platforms.filter((p) => p.failed) ?? [];
  const more = data?.platforms.some((p) => p.more) ?? false;
  let index = 0;

  return (
    <>
      <PageHead
        title="Pull requests"
        sub="Open pull requests and merge requests that ask your review, and yours, on every connected platform. j and k move, Enter opens, / filters, r refreshes."
        actions={
          <Seg
            label="Show"
            value={shown}
            onChange={(v) => {
              setShown(v);
              setAt(0);
            }}
            options={[
              { value: "all", label: "All" },
              { value: "review", label: "Review" },
              { value: "authored", label: "Yours" },
            ]}
          />
        }
      />
      <div className="toolbar">
        <input
          ref={filter}
          type="search"
          placeholder="Filter by repository, title or author"
          aria-label="Filter"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
          }}
        />
        <label>
          <input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} />{" "}
          Drafts
        </label>
        <span className="muted small" role="status">
          {data && stale ? "Refreshing…" : ""}
        </span>
      </div>
      {failed.map((p) => (
        <p key={p.host} className="error" role="alert">
          Could not read pull requests from {p.host}.{" "}
          <button type="button" className="btn btn-sm" onClick={reload}>
            Try again
          </button>
        </p>
      ))}
      {unlinked.map((p) => (
        <p key={p.host} className="muted small">
          {p.host} is not connected. <Link to="/repositories">Connect it under Repositories</Link>.
        </p>
      ))}
      {error && !data ? (
        <LoadError what="pull requests" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="pull requests" />
      ) : (
        <div ref={list}>
          {sections.map((s) => (
            <div key={s.section} className="section card">
              <div className="card-head">
                <h3>{s.title}</h3>
                <span className="subtle small">{s.rows.length}</span>
              </div>
              {s.rows.length === 0 ? (
                <div className="empty">{text || !drafts ? "None match." : s.empty}</div>
              ) : (
                s.rows.map((r) => {
                  const i = index++;
                  return <PullRow key={`${r.host}:${r.id}`} r={r} i={i} on={i === current} />;
                })
              )}
            </div>
          ))}
          {more && (
            <p className="muted small">
              Showing the 50 most recently updated of each list; filter on the platform for older
              ones.
            </p>
          )}
        </div>
      )}
      {error && data ? <p className="error">Could not refresh: {why(error)}.</p> : null}
    </>
  );
}

function PullRow(props: { r: Row; i: number; on: boolean }) {
  const { r } = props;
  const checks = r.checks && CHECKS[r.checks];
  const review = r.review && REVIEW[r.review];
  return (
    <a
      className={`list-row pull-row${props.on ? " current" : ""}`}
      href={r.url}
      target="_blank"
      rel="noreferrer"
      data-row={props.i}
      aria-current={props.on ? "true" : undefined}
    >
      <div className="grow">
        <div className="pull-title">{r.title}</div>
        <div className="mono subtle small">
          {r.repo}#{r.number}
          {r.author ? ` · ${r.author}` : ""} · updated {ago(r.updatedAt)}
        </div>
      </div>
      {r.draft && <span className="badge">Draft</span>}
      {checks && <span className={`badge ${checks.cls}`}>{checks.label}</span>}
      {review && <span className={`badge ${review.cls}`}>{review.label}</span>}
      {r.additions !== null && r.deletions !== null && (
        <span className="mono small subtle">
          +{r.additions} −{r.deletions}
        </span>
      )}
    </a>
  );
}
