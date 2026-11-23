import Clock from "lucide-react/icons/clock";
import type { ReactNode } from "react";
import type {
  CodeOwnerGroupView,
  PullReadinessView,
  ReadinessItem,
  ReadinessKind,
  ReadinessState,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { count } from "../format.js";
import { CloseGlyph, DoneGlyph } from "../glyphs.js";
import { useLoad } from "../ui.js";
import { Tally } from "./tally.js";

// What still stands between this pull request and its merge, one line per
// requirement, read live as the user. A requirement the user's token cannot
// read is shown quietly: it is not a failure.

const LABEL: Record<ReadinessKind, string> = {
  draft: "Draft",
  conflicts: "Conflicts",
  approvals: "Approvals",
  code_owners: "Code owners",
  required_checks: "Required checks",
  threads: "Threads",
  premerge_checks: "Pre-merge checks",
};

const MARK: Record<ReadinessState, { label: string; cls: string }> = {
  met: { label: "Met", cls: "ok" },
  unmet: { label: "Not met", cls: "err" },
  pending: { label: "Waiting", cls: "wait" },
  unknown: { label: "Cannot be read", cls: "muted" },
};

function Mark(props: { state: ReadinessState }) {
  const mark = MARK[props.state];
  return (
    <span className={`check-mark ${mark.cls}`} role="img" aria-label={mark.label}>
      {props.state === "met" && <DoneGlyph size={14} />}
      {props.state === "unmet" && <CloseGlyph size={14} />}
      {props.state === "pending" && <Clock size={14} aria-hidden="true" />}
    </span>
  );
}

const RULE: Record<string, string> = {
  merge_queue: "a merge queue",
  required_deployments: "deployments",
  required_signatures: "signed commits",
  required_linear_history: "a linear history",
  code_scanning: "code scanning",
  workflows: "workflows",
  update: "permission to update the branch",
};
const ruleName = (type: string) => RULE[type] ?? type.replaceAll("_", " ");

function ownerLine(group: CodeOwnerGroupView): string {
  const files = group.files === null ? "" : `, ${count(group.files, "file")}`;
  if (group.approvedBy.length > 0) return `approved by ${group.approvedBy.join(", ")}${files}`;
  const need = group.required === false ? "optional" : "not approved yet";
  return `${group.state === "unknown" ? "cannot be read" : need}${files}`;
}

function Owners(props: { groups: CodeOwnerGroupView[] }) {
  return (
    <ul className="readiness-owners">
      {props.groups.map((g) => (
        <li key={g.owners.join(" ")}>
          <Mark state={g.state} />
          <span className="small">
            <span className="mono">{g.owners.join(" ")}</span>{" "}
            <span className="subtle">{ownerLine(g)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

type Pull = { platform: string; repo: string; number: number };

/** What stands between the pull request and its merge, read again when its head moves. */
export function useReadiness(
  pull: Pull,
  head: string | undefined,
  /** Counts up to read again at the same head. */
  rev = 0,
): PullReadinessView | undefined {
  const q = new URLSearchParams({ ...pull, number: String(pull.number) }).toString();
  const { data } = useLoad(
    () => (head ? api<PullReadinessView>(`/pulls/readiness?${q}`) : Promise.resolve(undefined)),
    [q, head, rev],
  );
  return data;
}

/** What is in the way first: it is what the user came to find. */
const ORDER: ReadinessState[] = ["unmet", "pending", "unknown", "met"];

function Item(props: { item: ReadinessItem; view: PullReadinessView }) {
  const { item: i, view } = props;
  return (
    <li className={i.state === "unknown" ? "readiness-unread" : undefined}>
      <Mark state={i.state} />
      <div>
        <div>{LABEL[i.kind]}</div>
        <div className="subtle small">{i.detail}</div>
        {i.kind === "code_owners" && view.codeOwners.length > 0 && (
          <Owners groups={view.codeOwners} />
        )}
        {i.kind === "approvals" && view.staleApprovals.length > 0 && (
          <div className="subtle small">
            Approved an earlier head: {view.staleApprovals.join(", ")}
          </div>
        )}
      </div>
    </li>
  );
}

export function ReadinessBox(props: {
  view: PullReadinessView | undefined;
  /** What the user can do about it here: updating a branch that fell behind. */
  children?: ReactNode;
}) {
  const data = props.view;
  if (!data?.ready) return null;
  const items = ORDER.flatMap((state) => data.items.filter((i) => i.state === state));
  const open = items.filter((i) => i.state !== "met");
  const met = items.filter((i) => i.state === "met");
  const unread = data.items.filter((i) => i.state === "unknown").length;
  return (
    <section className="card card-pad stack" aria-label="Merge readiness">
      <div className="row-gap checks-head">
        <h2 className="card-title grow">Merge readiness</h2>
        {/* The page's head carries the standing; here it is said only when the head is silent. */}
        {data.ready === "unknown" ? (
          <span className="badge">Nothing in the way</span>
        ) : (
          <span className="subtle small">
            {met.length} of {data.items.length} met
          </span>
        )}
      </div>
      <Tally
        label={`${met.length} of ${data.items.length} met`}
        parts={[
          { tone: "ok", n: met.length },
          { tone: "err", n: items.filter((i) => i.state === "unmet").length },
          {
            tone: "wait",
            n: items.filter((i) => i.state === "pending" || i.state === "unknown").length,
          },
        ]}
      />
      {open.length > 0 && (
        <ul className="check-results">
          {open.map((i) => (
            <Item key={i.kind} item={i} view={data} />
          ))}
        </ul>
      )}
      {met.length > 0 && (
        <details className="readiness-met" open={open.length === 0}>
          <summary className="subtle small">
            <span className="fold" aria-hidden="true" />
            {met.length} met
            {unread > 0 && `, ${unread} not readable with your sign-in`}
          </summary>
          <ul className="check-results">
            {met.map((i) => (
              <Item key={i.kind} item={i} view={data} />
            ))}
          </ul>
        </details>
      )}
      {props.children}
      {data.otherRules.length > 0 && (
        <span className="subtle small">
          Also required by branch rules: {data.otherRules.map(ruleName).join(", ")}
        </span>
      )}
    </section>
  );
}
