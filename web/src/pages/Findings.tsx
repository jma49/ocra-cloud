import Flag from "lucide-react/icons/flag";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  DecisionStatus,
  DismissReason,
  FindingRule,
  FindingStatus,
  Severity,
  Verification,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { DISMISS_REASONS, reasonLabel } from "../dismiss-reasons.js";
import { FindingReactions } from "../finding-reactions.js";
import { RuleFilter, ruleName } from "../finding-rule-filter.js";
import { FINDING_STATUS_NAME, FindingStanding } from "../finding-status.js";
import { ago } from "../format.js";
import { useListCursor } from "../list-cursor.js";
import { usePageCommands } from "../page-commands.js";
import { Link } from "../router.js";
import { StackTable } from "../stack-table.js";
import { useToast } from "../toast.js";
import { EmptyState, LoadError, Loading, PageHead, Seg, useAction } from "../ui.js";
import { findingsCommands } from "./findings-commands.js";

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
  /** The pull request the review was of, if any. */
  prNumber: number | null;
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
  thumbsUp: number;
  thumbsDown: number;
  rule: FindingRule;
  createdAt: string;
};
type Page = { findings: Listed[]; next: string | null; statuses: Record<FindingStatus, number> };

type StatusFilter = FindingStatus | "all";
type Filters = {
  status: StatusFilter;
  severity: Severity | "";
  verification: Verification | "none" | "";
  repo: string;
  /** "<kind>:<id>", "none" or "" for any. */
  rule: string;
};

const SEV_CLASS = { critical: "badge-err", warning: "badge-warn", suggestion: "" } as const;

function query(f: Filters, after?: string): string {
  const q = new URLSearchParams();
  if (f.status !== "all") q.set("status", f.status);
  if (f.severity) q.set("severity", f.severity);
  if (f.verification) q.set("verification", f.verification);
  if (f.repo) q.set("repo", f.repo);
  if (f.rule) q.set("rule", f.rule);
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

type Decision = { status: DecisionStatus; reason?: DismissReason; note?: string };

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

const STATUS_DONE: Record<DecisionStatus, string> = {
  open: "reopened",
  fixed: "marked fixed",
  dismissed: "dismissed",
};

/** Who found it, in what category, how it was checked and the rule it names; a category the reviewer is named after once. */
const notes = (f: Listed) =>
  [
    f.reviewer,
    f.category === f.reviewer ? null : f.category,
    f.verification,
    f.rule && ruleName(f.rule),
  ]
    .filter(Boolean)
    .join(" · ");

const rowClass = (selected: boolean, current: boolean) =>
  [selected && "selected", current && "is-current"].filter(Boolean).join(" ") || undefined;

export function Findings(props: {
  /** Whether this server runs reviews itself, whose findings need no sharing. */
  runner?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>({
    status: "open",
    severity: "",
    verification: "",
    repo: "",
    rule: "",
  });
  const path = `/findings${query(filters)}`;
  const { data, error, reload, change } = useCached(path, () => api<Page>(path));
  const [more, setMore] = useState<{ for: Page; rows: Listed[]; next: string | null }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<DismissReason>("false_positive");
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const toast = useToast();

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
    cursor.reset();
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const apply = async (status: DecisionStatus, ids = [...selected]) => {
    if (ids.length === 0) return;
    const body =
      status === "dismissed"
        ? { ids, status, reason, ...(note.trim() ? { note: note.trim() } : {}), remember }
        : { ids, status };
    // Open findings only: what a dismissal remembered stays remembered.
    const undoable =
      !(status === "dismissed" && remember) &&
      ids.every((id) => rows.find((r) => r.id === id)?.status === "open");
    const undo = change((page) => decided(page, new Set(ids), filters.status, body));
    const answer = await decide.run(body);
    if (!answer) {
      undo();
      return;
    }
    const memory =
      answer.remembered > 0 ? `, ${answer.remembered} remembered for their repository` : "";
    const full = answer.memoryFull ? " (a repository's memory is full; forget some first)" : "";
    toast(
      `${answer.changed} ${STATUS_DONE[status]}${memory}${full}`,
      "success",
      undoable && status !== "open"
        ? { label: "Undo", run: () => void apply("open", ids) }
        : undefined,
    );
    setSelected(new Set());
    setNote("");
    reload();
  };

  const table = useRef<HTMLTableSectionElement>(null);
  const reasonBox = useRef<HTMLSelectElement>(null);
  const cursor = useListCursor(rows.length, table);
  usePageCommands(
    "These findings",
    findingsCommands({
      row: rows[cursor.current],
      selected,
      move: cursor.move,
      toggle: (id) => {
        toggle(id);
        cursor.show();
      },
      markFixed: (ids) => void apply("fixed", ids),
      dismiss: (ids) => {
        setSelected(new Set(ids));
        // The bar with the reason shows once something is selected.
        requestAnimationFrame(() => reasonBox.current?.focus());
      },
      clear: () => setSelected(new Set()),
    }),
  );

  const counts = data?.statuses;
  const option = (s: FindingStatus) => ({
    value: s,
    label: counts ? `${FINDING_STATUS_NAME[s]} (${counts[s]})` : FINDING_STATUS_NAME[s],
  });

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
              option("open"),
              option("fixed"),
              option("dismissed"),
              option("addressed"),
              option("merged"),
              { value: "all", label: "All" },
            ]}
          />
          <label>
            Severity{" "}
            <select
              className="input"
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
              className="input"
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
            <select
              className="input"
              value={filters.repo}
              onChange={(e) => set({ repo: e.target.value })}
            >
              <option value="">Any</option>
              {repos.map(([hash, short]) => (
                <option key={hash} value={hash}>
                  {short}
                </option>
              ))}
            </select>
          </label>
          <RuleFilter
            value={filters.rule}
            rules={rows.map((r) => r.rule)}
            onChange={(rule) => set({ rule })}
          />
        </div>

        {selected.size > 0 && (
          <fieldset className="toolbar bulk" disabled={decide.busy}>
            <span className="small">{selected.size} selected</span>
            <Button type="button" variant="outline" size="sm" onClick={() => apply("fixed")}>
              Mark fixed
            </Button>
            <label>
              Reason{" "}
              <select
                ref={reasonBox}
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value as DismissReason)}
              >
                {DISMISS_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="text"
              className="input"
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
            <Button type="button" variant="outline" size="sm" onClick={() => apply("dismissed")}>
              Dismiss
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => apply("open")}>
              Reopen
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </fieldset>
        )}
        {decide.error ? (
          <p className="error" role="alert">
            Could not update them: {why(decide.error)}.
          </p>
        ) : null}

        {error && !data ? (
          <LoadError what="findings" error={error} retry={reload} />
        ) : !data ? (
          <Loading what="findings" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Flag}
            title="No findings here"
            action={
              props.runner ? (
                <Button variant="outline" render={<Link to="/auto-review" />}>
                  Set up auto review
                </Button>
              ) : (
                <Button variant="outline" render={<Link to="/settings" />}>
                  Open settings
                </Button>
              )
            }
          >
            {props.runner
              ? "Findings come from ocra's reviews of pull requests in repositories with auto review on, and from CLI reviews once you turn on sharing in Settings."
              : "Findings appear once you turn on sharing in Settings and a signed-in review uploads them."}
          </EmptyState>
        ) : (
          <StackTable>
            <table className="findings-table">
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
              <tbody ref={table}>
                {rows.map((f, i) => (
                  <tr
                    key={f.id}
                    data-row={i}
                    className={rowClass(selected.has(f.id), cursor.shown && i === cursor.current)}
                  >
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
                      <div className="subtle small">
                        <span className="mono">
                          {f.file}
                          {lines(f)}
                        </span>{" "}
                        · {notes(f)}
                      </div>
                    </td>
                    <td className={f.name ? undefined : "mono"}>
                      {f.name ?? f.repo}
                      {f.prNumber !== null && <span className="subtle"> #{f.prNumber}</span>}
                    </td>
                    <td>
                      <FindingStanding status={f.status} />
                      {f.reason && <div className="muted small">{reasonLabel(f.reason)}</div>}
                      {f.note && <div className="subtle small">{f.note}</div>}
                      <FindingReactions up={f.thumbsUp} down={f.thumbsDown} />
                    </td>
                    <td className="muted">{ago(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
        )}
        {next && (
          <Button
            type="button"
            variant="outline"
            disabled={loadMore.busy}
            onClick={() => loadMore.run()}
          >
            {loadMore.busy ? "Loading…" : "Load more"}
          </Button>
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
