import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  GraphRepoView,
  ImpactSymbol,
  ImpactUse,
  Severity,
} from "../../../src/shared/index.js";
import { Link } from "../router.js";
import { lineUrl, noticesOf, type RailNotice, short, symbolsOf } from "./select.js";
import type { Impact } from "./use-impact.js";

// The review page's impact rail: the uses a pull request's changed symbols
// have outside it, for the whole pull request or for one finding. Every
// name, path and code line is rendered as text: they come from the
// reviewed repository.

export type FocusedFinding = {
  id: string;
  file: string;
  lineStart: number | null;
  severity: Severity;
  body: string;
};

type Props = { impact: Impact; finding: FocusedFinding | null; onClose: () => void };

export function ImpactRail(props: Props) {
  const { impact, finding } = props;
  if (impact.state === "off") return null;
  return (
    <aside className={`card impact-rail${finding ? " is-open" : ""}`} aria-label="Impact">
      <div className="impact-head">
        <div className="grow">
          <h2>Impact</h2>
          <div className="subtle small">
            {finding ? (
              <>
                Of the {finding.severity} finding at{" "}
                <span className="mono">
                  {finding.file.split("/").pop()}
                  {finding.lineStart === null ? "" : `:${finding.lineStart}`}
                </span>
              </>
            ) : (
              "Uses of what the pull request changes. Pick a finding to narrow it."
            )}
          </div>
        </div>
        {finding && (
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Show all
          </Button>
        )}
      </div>
      <RailBody impact={impact} finding={finding} />
    </aside>
  );
}

function RailBody(props: { impact: Impact; finding: FocusedFinding | null }) {
  const { impact, finding } = props;
  if (impact.state === "loading") return <p className="impact-pad subtle">Reading the graph…</p>;
  if (impact.state === "error") {
    return (
      <div className="impact-pad">
        <p className="m-0">The impact could not be read.</p>
        <Button variant="outline" size="sm" onClick={impact.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (impact.state === "unkept") {
    return (
      <div className="impact-pad">
        <p className="m-0 strong">See who uses what this pull request changed</p>
        <p className="subtle small">
          ocra keeps a graph of a repository's symbol names, kinds and lines, never its code, and
          updates it on every push.
        </p>
        <Button variant="outline" size="sm" render={<Link to="/code-graphs" />}>
          Keep a code graph
        </Button>
      </div>
    );
  }
  if (impact.state !== "ready") return null;
  const { view, repo } = impact;
  const shown = finding ? symbolsOf(view.symbols, finding) : view.symbols;
  return (
    <>
      {noticesOf(view).map((n) => (
        <Notice key={n.kind} notice={n} />
      ))}
      {view.graph &&
        (shown.length === 0 ? (
          <p className="impact-pad muted">
            {finding
              ? "This finding's lines are in no symbol the pull request changes."
              : "The pull request changes no symbol the graph knows."}
          </p>
        ) : (
          shown.map((s, i) => (
            <SymbolBlock
              key={`${finding?.id ?? "all"}:${s.path}:${s.startLine}:${s.name}`}
              symbol={s}
              repo={repo}
              commit={view.graph?.commit ?? ""}
              finding={finding}
              open={finding !== null || i === 0}
            />
          ))
        ))}
      {view.more > 0 && !finding && (
        <p className="impact-pad subtle small">{view.more} more changed symbols are not listed.</p>
      )}
      {view.graph && (
        <p className="impact-foot subtle small">
          Graph of <span className="mono">{short(view.graph.commit)}</span>
          {view.graph.files === null
            ? ""
            : ` · ${view.graph.files.toLocaleString()} file${view.graph.files === 1 ? "" : "s"}`}{" "}
          · matched by name, not type-resolved.
        </p>
      )}
    </>
  );
}

function Notice(props: { notice: RailNotice }) {
  const n = props.notice;
  const text =
    n.kind === "building"
      ? `Building the graph of ${short(n.commit)}. Uses appear here when it finishes.`
      : n.kind === "failed"
        ? `The graph of ${short(n.commit)} could not be built. ocra tries again on the next push.`
        : n.kind === "unreviewed"
          ? "ocra works out what a pull request reaches when it reviews it here. Review this one again to see it."
          : n.kind === "behind"
            ? `The graph is of ${short(n.commit)}, not the pull request's base. Uses in files changed since may be missing or moved.`
            : "The platform cut this repository's file list short, so uses in the files past the cut are missing.";
  return (
    <p className={`impact-note${n.kind === "behind" || n.kind === "cut" ? " warn" : ""}`}>{text}</p>
  );
}

function SymbolBlock(props: {
  symbol: ImpactSymbol;
  repo: GraphRepoView;
  commit: string;
  finding: FocusedFinding | null;
  open: boolean;
}) {
  const { symbol: s, finding } = props;
  const [open, setOpen] = useState(props.open);
  const more = s.useCount - s.uses.length;
  return (
    <section className="impact-symbol">
      <button
        type="button"
        className="impact-symbol-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="grow">
          <span className="mono strong">{s.name}</span>{" "}
          <span className="subtle small">
            {s.kind} · {s.change === "added" ? "new" : `${s.change} changed`}
          </span>
          <span className="mono subtle small impact-where">
            {s.path}:{s.startLine}–{s.endLine}
          </span>
        </span>
        <span className="small subtle impact-count">
          {s.useCount} use{s.useCount === 1 ? "" : "s"}
          {s.fileCount > 0 ? ` · ${s.fileCount} file${s.fileCount === 1 ? "" : "s"}` : ""}
        </span>
      </button>
      {open &&
        (s.uses.length === 0 ? (
          <p className="impact-pad impact-none subtle small">No uses outside this pull request.</p>
        ) : (
          <ul className="impact-uses">
            {s.uses.map((u) => (
              <UseRow
                key={`${u.path}:${u.line}`}
                use={u}
                href={lineUrl(props.repo, props.commit, u.path, u.line)}
                named={finding?.severity === "critical" && named(finding.body, u)}
              />
            ))}
            {more > 0 && (
              <li className="impact-pad subtle small">{more} more uses are not listed.</li>
            )}
          </ul>
        ))}
    </section>
  );
}

/** A use the finding's text names by the definition it sits in. */
const named = (body: string, use: ImpactUse) =>
  use.within !== null && new RegExp(`\\b${use.within.replace(/[$]/g, "\\$")}\\b`).test(body);

function UseRow(props: { use: ImpactUse; href: string; named: boolean }) {
  const { use: u } = props;
  return (
    <li>
      <a className="impact-use" href={props.href} target="_blank" rel="noreferrer">
        <span className={`impact-dot${props.named ? " pen" : ""}`} aria-hidden="true" />
        <span className="grow impact-text">
          <span className="impact-use-head">
            <span className="mono">
              {u.path}:{u.line}
            </span>
            {u.within && <span className="subtle small">in {u.within}</span>}
            {props.named && <span className="small impact-named">named in the finding</span>}
          </span>
          {u.code !== null && <code className="impact-code">{u.code}</code>}
        </span>
      </a>
    </li>
  );
}
