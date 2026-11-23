import Clock from "lucide-react/icons/clock";
import type {
  CodeOwnerGroupView,
  PullReadinessView,
  ReadinessKind,
  ReadinessState,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { count } from "../format.js";
import { CloseGlyph, DoneGlyph } from "../glyphs.js";
import { useLoad } from "../ui.js";

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

const SUMMARY: Record<ReadinessState, { text: string; tone: string }> = {
  met: { text: "Ready to merge", tone: "badge badge-ok" },
  unmet: { text: "Not ready", tone: "badge badge-err" },
  pending: { text: "Waiting", tone: "badge" },
  unknown: { text: "Nothing in the way", tone: "badge" },
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
      {props.state === "pending" && <Clock size={13} aria-hidden="true" />}
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

export function ReadinessBox(props: { pull: Pull; head: string }) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data } = useLoad(
    () => api<PullReadinessView>(`/pulls/readiness?${q}`),
    [q.toString(), props.head],
  );
  if (!data?.ready) return null;
  const s = SUMMARY[data.ready];
  const met = data.items.filter((i) => i.state === "met").length;
  const unread = data.items.filter((i) => i.state === "unknown").length;
  return (
    <section className="card card-pad stack" aria-label="Merge readiness">
      <div className="row-gap checks-head">
        <span className="strong grow">Merge readiness</span>
        <span className={s.tone}>{s.text}</span>
      </div>
      <span className="subtle small">
        {met} of {data.items.length} met
        {unread > 0 && `, ${unread} not readable with your sign-in`}
      </span>
      <ul className="check-results">
        {data.items.map((i) => (
          <li key={i.kind} className={i.state === "unknown" ? "readiness-unread" : undefined}>
            <Mark state={i.state} />
            <div>
              <div>{LABEL[i.kind]}</div>
              <div className="subtle small">{i.detail}</div>
              {i.kind === "code_owners" && data.codeOwners.length > 0 && (
                <Owners groups={data.codeOwners} />
              )}
              {i.kind === "approvals" && data.staleApprovals.length > 0 && (
                <div className="subtle small">
                  Approved an earlier head: {data.staleApprovals.join(", ")}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {data.otherRules.length > 0 && (
        <span className="subtle small">
          Also required by branch rules: {data.otherRules.map(ruleName).join(", ")}
        </span>
      )}
    </section>
  );
}
