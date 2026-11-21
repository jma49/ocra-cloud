import { useState } from "react";
import type {
  DismissReason,
  FindingStatus,
  Severity,
  Verification,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago } from "../format.js";
import { Link } from "../router.js";
import { LoadError, Loading, PageHead, Seg, useAction } from "../ui.js";

// Every shared finding of the account, across its reviews: filter them,
// mark them fixed, dismiss them with a reason (and remember them for the
// repository), or open them again. Every text is plain text: findings
// quote untrusted code.

type Listed = {
  id: string;
  reviewId: string;
  repoHash: string;
  repo: string;
  name: string | null;
  reviewer: string;
  severity: Severity;
  category: string | null;
  verification: Verification | null;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  status: FindingStatus;
  reason: DismissReason | null;
  note: string | null;
  decidedAt: string | null;
  createdAt: string;
};
type Page = { findings: Listed[]; next: string | null; statuses: Record<FindingStatus, number> };

type StatusFilter = FindingStatus | "all";
type Filters = {
  status: StatusFilter;
  severity: Severity | "";
  verification: Verification | "none" | "";
  repo: string;
};

const REASONS: { value: DismissReason; label: string }[] = [
  { value: "false_positive", label: "False positive" },
  { value: "not_important", label: "Not important" },
  { value: "wrong_fix", label: "Suggested fix is wrong" },
  { value: "already_known", label: "Already known" },
];
const reasonLabel = (r: DismissReason) => REASONS.find((x) => x.value === r)?.label ?? r;
const SEV_CLASS = { critical: "badge-err", warning: "badge-warn", suggestion: "" } as const;

function query(f: Filters, after?: string): string {
  const q = new URLSearchParams();
  if (f.status !== "all") q.set("status", f.status);
  if (f.severity) q.set("severity", f.severity);
  if (f.verification) q.set("verification", f.verification);
  if (f.repo) q.set("repo", f.repo);
  if (after) q.set("after", after);
  const s = q.toString();
  return s ? `?${s}` : "";
}

const lines = (f: Listed) =>
  f.lineStart === null
    ? ""
    : f.lineEnd !== null && f.lineEnd !== f.lineStart
      ? `:${f.lineStart}-${f.lineEnd}`
      : `:${f.lineStart}`;

type Decision = { status: FindingStatus; reason?: DismissReason; note?: string };

/**
 * The page as it will be once the decision lands, shown before the server
 * answers: rows that leave the status filter go, the rest change in place,
 * and the counts move with them.
 */
export function decided(page: Page, ids: Set<string>, shown: StatusFilter, d: Decision): Page {
  const statuses = { ...page.statuses };
  const findings: Listed[] = [];
  for (const f of page.findings) {
    if (!ids.has(f.id) || f.status === d.status) {
      findings.push(f);
      continue;
    }
    statuses[f.status]--;
    statuses[d.status]++;
    if (shown !== "all" && shown !== d.status) continue;
    const open = d.status === "open";
    findings.push({
      ...f,
      status: d.status,
      reason: open ? null : (d.reason ?? null),
      note: open ? null : (d.note ?? null),
      decidedAt: open ? null : new Date().toISOString(),
    });
  }
  return { ...page, findings, statuses };
}

export function Findings() {
  const [filters, setFilters] = useState<Filters>({
    status: "open",
    severity: "",
    verification: "",
    repo: "",
  });
  const path = `/findings${query(filters)}`;
  const { data, error, reload, change } = useCached(path, () => api<Page>(path));
  const [more, setMore] = useState<{ for: Page; rows: Listed[]; next: string | null }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<DismissReason>("false_positive");
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [done, setDone] = useState("");

  const extra = more && more.for === data ? more : undefined;
  const rows = [...(data?.findings ?? []), ...(extra?.rows ?? [])];
  const next = extra ? extra.next : (data?.next ?? null);
  const repos = [...new Map(rows.map((r) => [r.repoHash, r.name ?? r.repo])).entries()];

  const loadMore = useAction(async () => {
    if (!data || !next) return;
    const page = await api<Page>(`/findings${query(filters, next)}`);
    setMore({ for: data, rows: [...(extra?.rows ?? []), ...page.findings], next: page.next });
  });
  const decide = useAction((body: object) =>
    api<{ changed: number; remembered: number; memoryFull?: boolean }>("/findings/decide", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

  const set = (change: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...change }));
    setSelected(new Set());
    setDone("");
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const apply = async (status: FindingStatus, ids = [...selected]) => {
    if (ids.length === 0) return;
    const body =
      status === "dismissed"
        ? { ids, status, reason, ...(note.trim() ? { note: note.trim() } : {}), remember }
        : { ids, status };
    setDone("");
    const undo = change((page) => decided(page, new Set(ids), filters.status, body));
    const answer = await decide.run(body);
    if (!answer) {
      undo();
      return;
    }
    const memory =
      answer.remembered > 0 ? `, ${answer.remembered} remembered for their repository` : "";
    const full = answer.memoryFull ? " (a repository's memory is full; forget some first)" : "";
    setDone(`${answer.changed} updated${memory}${full}.`);
    setSelected(new Set());
    setNote("");
    reload();
  };

  const counts = data?.statuses;
  const label = (s: FindingStatus, name: string) => (counts ? `${name} (${counts[s]})` : name);

  return (
    <>
      <PageHead
        title="Findings"
        sub="Every shared finding across your reviews. Mark what was fixed, dismiss what was wrong with a reason, and remember dismissals so the repository's next review stops reporting them."
      />
      <div className="card">
        <div className="toolbar">
          <Seg
            label="Status"
            value={filters.status}
            onChange={(status) => set({ status })}
            options={[
              { value: "open", label: label("open", "Open") },
              { value: "fixed", label: label("fixed", "Fixed") },
              { value: "dismissed", label: label("dismissed", "Dismissed") },
              { value: "all", label: "All" },
            ]}
          />
          <label>
            Severity{" "}
            <select
              value={filters.severity}
              onChange={(e) => set({ severity: e.target.value as Filters["severity"] })}
            >
              <option value="">Any</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="suggestion">Suggestion</option>
            </select>
          </label>
          <label>
            Verified{" "}
            <select
              value={filters.verification}
              onChange={(e) => set({ verification: e.target.value as Filters["verification"] })}
            >
              <option value="">Any</option>
              <option value="confirmed">Confirmed</option>
              <option value="uncertain">Uncertain</option>
              <option value="unchecked">Unchecked</option>
              <option value="none">Not verified</option>
            </select>
          </label>
          <label>
            Repository{" "}
            <select value={filters.repo} onChange={(e) => set({ repo: e.target.value })}>
              <option value="">Any</option>
              {repos.map(([hash, short]) => (
                <option key={hash} value={hash}>
                  {short}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="toolbar" disabled={selected.size === 0 || decide.busy}>
          <span className="muted small">{selected.size} selected</span>
          <button type="button" className="btn btn-sm" onClick={() => apply("fixed")}>
            Mark fixed
          </button>
          <label>
            Reason{" "}
            <select value={reason} onChange={(e) => setReason(e.target.value as DismissReason)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <input
            type="text"
            placeholder="Note (optional)"
            aria-label="Note"
            maxLength={4096}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />{" "}
            Remember
          </label>
          <button type="button" className="btn btn-sm" onClick={() => apply("dismissed")}>
            Dismiss
          </button>
          <button type="button" className="btn btn-sm" onClick={() => apply("open")}>
            Reopen
          </button>
        </fieldset>
        {decide.error ? (
          <p className="error" role="alert">
            Could not update them: {why(decide.error)}.
          </p>
        ) : (
          done && (
            <p className="muted small" role="status">
              {done}
            </p>
          )
        )}

        {error && !data ? (
          <LoadError what="findings" error={error} retry={reload} />
        ) : !data ? (
          <Loading what="findings" />
        ) : rows.length === 0 ? (
          <div className="empty-hero">
            <h3>No findings here</h3>
            <p>
              Findings appear once you turn on sharing in Settings and a signed-in review uploads
              them.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allOn}
                      onChange={() =>
                        setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))
                      }
                    />
                  </th>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>Repository</th>
                  <th>Status</th>
                  <th>Found</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.title}`}
                        checked={selected.has(f.id)}
                        onChange={() => toggle(f.id)}
                      />
                    </td>
                    <td>
                      <span className={`badge ${SEV_CLASS[f.severity]}`}>{f.severity}</span>
                    </td>
                    <td className="finding-cell">
                      <div>
                        <Link to={`/reviews/${f.reviewId}`}>{f.title}</Link>
                      </div>
                      <div className="mono subtle small">
                        {f.file}
                        {lines(f)} · {f.reviewer}
                        {f.category ? ` · ${f.category}` : ""}
                        {f.verification ? ` · ${f.verification}` : ""}
                      </div>
                    </td>
                    <td className="mono">{f.name ?? f.repo}</td>
                    <td>
                      {f.status}
                      {f.reason && <div className="muted small">{reasonLabel(f.reason)}</div>}
                      {f.note && <div className="subtle small">{f.note}</div>}
                    </td>
                    <td className="muted">{ago(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <button
            type="button"
            className="btn"
            disabled={loadMore.busy}
            onClick={() => loadMore.run()}
          >
            {loadMore.busy ? "Loading…" : "Load more"}
          </button>
        )}
        {loadMore.error ? (
          <p className="error" role="alert">
            Could not load more: {why(loadMore.error)}.
          </p>
        ) : null}
      </div>
    </>
  );
}
