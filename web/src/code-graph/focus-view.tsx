import { Button } from "@/components/ui/button";
import type { GraphRepoView } from "../../../src/shared/index.js";
import { lineUrl } from "../impact/select.js";
import { EmptyNote } from "../ui.js";
import type { GraphClient } from "./client.js";
import { type Column, ColumnGraph, type ColumnItem, type Join, useCapped } from "./columns.js";
import { baseOf, dirOf, FileMark, PathText, SymbolMark, uses } from "./marks.js";
import type { GraphPlace } from "./place.js";
import type { FileFocus, Neighbour, SymbolFocus, SymbolRef } from "./queries.js";
import { useAnswer } from "./use-graph.js";

// One file or symbol and its neighbours: what uses it on the left, what it
// uses on the right, the details beside them.

type Go = (to: GraphPlace) => void;

export function FocusView(props: {
  client: GraphClient;
  repo: GraphRepoView;
  commit: string;
  place: Extract<GraphPlace, { view: "focus" }>;
  go: Go;
}) {
  const { place } = props;
  const asked = useAnswer(props.client, {
    type: "focus",
    path: place.path,
    ...(place.symbol ? { symbol: place.symbol } : {}),
  });
  if (asked.error) return <EmptyNote>This part of the graph could not be read.</EmptyNote>;
  if (!asked.data && asked.busy) return <p className="graph-wait">Following the uses…</p>;
  if (!asked.data) {
    return (
      <div className="graph-missing">
        <p>
          The graph of this commit has no file at <PathText path={place.path} />.
        </p>
        <Button variant="outline" size="sm" onClick={() => props.go({ view: "map", folder: "" })}>
          Show the map
        </Button>
      </div>
    );
  }
  const focus = asked.data;
  return (
    <div className="graph-work">
      <div className={`graph-stage${asked.busy ? " is-busy" : ""}`}>
        {focus.focus === "symbol" ? (
          <SymbolGraph key={JSON.stringify(place)} focus={focus} go={props.go} />
        ) : (
          <FileGraph key={place.path} focus={focus} go={props.go} />
        )}
      </div>
      {focus.focus === "symbol" ? (
        <SymbolDetails focus={focus} repo={props.repo} commit={props.commit} go={props.go} />
      ) : (
        <FileDetails focus={focus} repo={props.repo} commit={props.commit} go={props.go} />
      )}
    </div>
  );
}

const symbolPlace = (s: SymbolRef): GraphPlace => ({
  view: "focus",
  path: s.path,
  symbol: { name: s.name, line: s.start },
});

function neighbourItem(n: Neighbour, go: Go): ColumnItem {
  if (n.as === "symbol") {
    return {
      key: `s:${n.symbol.path}:${n.symbol.start}:${n.symbol.name}`,
      mark: <SymbolMark kind={n.symbol.kind} />,
      name: <span className="mono">{n.symbol.name}</span>,
      sub: <PathText path={`${n.symbol.path}:${n.symbol.start}`} />,
      meta: uses(n.weight),
      label: `${n.symbol.name}, ${n.symbol.kind} in ${n.symbol.path}`,
      open: () => go(symbolPlace(n.symbol)),
    };
  }
  return {
    key: `${n.as}:${n.path}`,
    mark: <FileMark path={n.path} />,
    name: <span className="mono">{baseOf(n.path)}</span>,
    sub: (
      <>
        <span className="mono">{folderOf(n.path)}</span>
        {n.as === "top" ? " · outside any definition" : ""}
      </>
    ),
    meta: uses(n.weight),
    label: n.path,
    open: () => go({ view: "focus", path: n.path }),
  };
}

function useColumn(list: Neighbour[], go: Go, title: string, empty: string): Column {
  const capped = useCapped(list.map((n) => neighbourItem(n, go)));
  return {
    title: `${title} · ${list.length.toLocaleString()}`,
    empty,
    ...capped,
  };
}

function joinsOf(center: string, left: ColumnItem[], right: ColumnItem[], weights: Neighbour[][]) {
  const [l = [], r = []] = weights;
  const joins: Join[] = [];
  for (const [i, item] of left.entries()) {
    joins.push({ from: item.key, to: center, weight: l[i]?.weight ?? 1 });
  }
  for (const [i, item] of right.entries()) {
    joins.push({ from: center, to: item.key, weight: r[i]?.weight ?? 1 });
  }
  return joins;
}

function SymbolGraph(props: { focus: SymbolFocus; go: Go }) {
  const { focus, go } = props;
  const s = focus.symbol;
  const left = useColumn(focus.callers, go, "Used by", "Nothing in the graph uses it.");
  const right = useColumn(focus.callees, go, "Uses", "It uses nothing the graph defines.");
  const key = `focus:${s.path}:${s.start}:${s.name}`;
  return (
    <ColumnGraph
      key={key}
      label={`What uses ${s.name} and what it uses`}
      left={left}
      center={{
        title: s.kind ? s.kind[0]?.toUpperCase() + s.kind.slice(1) : "Symbol",
        empty: "",
        items: [
          {
            key,
            tone: "focus",
            mark: <SymbolMark kind={s.kind} />,
            name: <span className="mono">{s.name}</span>,
            sub: <PathText path={`${s.path}:${s.start}–${s.end}`} />,
          },
        ],
      }}
      right={right}
      joins={joinsOf(key, left.items, right.items, [focus.callers, focus.callees])}
    />
  );
}

function FileGraph(props: { focus: FileFocus; go: Go }) {
  const { focus, go } = props;
  const left = useColumn(focus.callers, go, "Used by", "No other file uses its symbols.");
  const right = useColumn(focus.callees, go, "Uses", "It uses no other file's symbols.");
  const key = `focus:${focus.path}`;
  return (
    <ColumnGraph
      key={key}
      label={`Files that use ${focus.path} and files it uses`}
      left={left}
      center={{
        title: "File",
        empty: "",
        items: [
          {
            key,
            tone: "focus",
            mark: <FileMark path={focus.path} />,
            name: <span className="mono">{baseOf(focus.path)}</span>,
            sub: <span className="mono">{folderOf(focus.path)}</span>,
            meta: `${focus.defs.length.toLocaleString()} symbol${focus.defs.length === 1 ? "" : "s"}`,
          },
        ],
      }}
      right={right}
      joins={joinsOf(key, left.items, right.items, [focus.callers, focus.callees])}
    />
  );
}

function DetailsHead(props: {
  title: React.ReactNode;
  sub: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="card-head graph-details-head">
      <div className="grow">
        <h2>{props.title}</h2>
        <div className="subtle small">{props.sub}</div>
      </div>
      <div className="graph-details-actions">{props.actions}</div>
    </div>
  );
}

function SymbolDetails(props: { focus: SymbolFocus; repo: GraphRepoView; commit: string; go: Go }) {
  const { focus, repo, commit } = props;
  const s = focus.symbol;
  const sites = focus.callers.flatMap((c) =>
    c.as === "file"
      ? []
      : c.lines.map((line) => ({
          path: c.path,
          line,
          within: c.as === "symbol" ? c.symbol.name : null,
        })),
  );
  return (
    <aside className="card graph-details" aria-label="Details">
      <DetailsHead
        title={<span className="mono">{s.name}</span>}
        sub={`${s.kind[0]?.toUpperCase() ?? ""}${s.kind.slice(1)} · ${lines(s)}`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.go({ view: "focus", path: s.path })}
            >
              Its file
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={
                <a href={lineUrl(repo, commit, s.path, s.start)} target="_blank" rel="noreferrer" />
              }
            >
              Open
            </Button>
          </>
        }
      />
      <div className="graph-where">
        <FileMark path={s.path} />
        <PathText path={s.path} />
      </div>
      {focus.namesakes > 1 && (
        <p className="impact-note warn">
          {focus.namesakes} files define a symbol named <span className="mono">{s.name}</span>. Uses
          are matched by name, so some of these may be of another one.
        </p>
      )}
      {focus.unresolved > 0 && (
        <p className="graph-quiet">
          {focus.unresolved === 1 ? "One name" : `${focus.unresolved} names`} it uses{" "}
          {focus.unresolved === 1 ? "is" : "are"} defined elsewhere under a name too common, or
          defined too often, to match, and left out.
        </p>
      )}
      <h3 className="graph-section">Where it is used</h3>
      {sites.length === 0 ? (
        <EmptyNote>No uses outside it.</EmptyNote>
      ) : (
        <ul className="graph-rows">
          {sites.map((u) => (
            <li key={`${u.path}:${u.line}`}>
              <a
                className="graph-row"
                href={lineUrl(repo, commit, u.path, u.line)}
                target="_blank"
                rel="noreferrer"
              >
                <FileMark path={u.path} />
                <PathText path={`${u.path}:${u.line}`} />
                <span className="graph-row-meta">{u.within ? `in ${u.within}` : "top level"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function FileDetails(props: { focus: FileFocus; repo: GraphRepoView; commit: string; go: Go }) {
  const { focus, repo, commit, go } = props;
  return (
    <aside className="card graph-details" aria-label="Details">
      <DetailsHead
        title={<PathText path={focus.path} />}
        sub={`Used by ${count(focus.callers.length, "file")} · uses ${count(focus.callees.length, "file")}`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => go({ view: "map", folder: dirOf(focus.path) })}
            >
              Its folder
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={
                <a href={lineUrl(repo, commit, focus.path, 1)} target="_blank" rel="noreferrer" />
              }
            >
              Open
            </Button>
          </>
        }
      />
      <h3 className="graph-section">Symbols · {focus.defs.length.toLocaleString()}</h3>
      {focus.defs.length === 0 ? (
        <EmptyNote>The parser found no definitions in this file.</EmptyNote>
      ) : (
        <ul className="graph-rows">
          {focus.defs.map((d) => (
            <li key={`${d.start}:${d.name}`}>
              <button type="button" className="graph-row" onClick={() => go(symbolPlace(d))}>
                <SymbolMark kind={d.kind} />
                <span className="mono graph-row-name">{d.name}</span>
                <span className="graph-row-meta">
                  {d.kind} · {lines(d)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

const lines = (s: { start: number; end: number }) =>
  s.start === s.end ? `line ${s.start}` : `lines ${s.start}–${s.end}`;

/** A file's folder, its last parts when it is deep: what tells two files of one name apart. */
const folderOf = (path: string) => {
  const parts = dirOf(path).split("/").filter(Boolean);
  if (parts.length === 0) return "Repository root";
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : parts.join("/");
};

const count = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? "" : "s"}`;
