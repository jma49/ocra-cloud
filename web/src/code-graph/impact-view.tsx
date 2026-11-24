import { Button } from "@/components/ui/button";
import type { GraphRepoView, ImpactSymbol, ImpactView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { lineUrl, noticesOf, short } from "../impact/select.js";
import { Link } from "../router.js";
import { EmptyNote, LoadError, Loading } from "../ui.js";
import { ColumnGraph, type ColumnItem, type Join, useCapped } from "./columns.js";
import { FileMark, PathText, SymbolMark, uses } from "./marks.js";
import type { GraphPlace } from "./place.js";

// A pull request's impact as a graph: the symbols it changes in the middle,
// the definitions that use them on the left. It reads the impact ocra
// worked out when it reviewed the pull request, so it draws before the
// whole graph is read.

type Go = (to: GraphPlace) => void;

const CHANGE: Record<ImpactSymbol["change"], Pick<ColumnItem, "meta" | "tone">> = {
  signature: { meta: "Signature changed", tone: "warn" },
  body: { meta: "Body changed" },
  added: { meta: "New", tone: "ok" },
};

export function ImpactGraph(props: { repo: GraphRepoView; pull: number; go: Go }) {
  const { repo, pull, go } = props;
  const path = `/graphs/repos/${repo.id}/impact?pull=${pull}`;
  const { data, error, reload } = useCached(path, () => api<ImpactView>(path));
  if (error && !data)
    return <LoadError what="the pull request's impact" error={error} retry={reload} inCard />;
  if (!data) return <Loading what="the pull request's impact" inCard />;
  return <ImpactBody key={pull} repo={repo} pull={pull} go={go} data={data} />;
}

const symbolKey = (s: ImpactSymbol) => `s:${s.path}:${s.startLine}:${s.name}`;

function ImpactBody(props: { repo: GraphRepoView; pull: number; go: Go; data: ImpactView }) {
  const { repo, pull, go, data } = props;
  const users = new Map<string, { item: ColumnItem; weight: number }>();
  const joins: Join[] = [];
  for (const s of data.symbols) {
    const weights = new Map<string, number>();
    for (const u of s.uses) {
      const key = `u:${u.path}:${u.within ?? ""}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
      const seen = users.get(key);
      if (seen) {
        seen.weight += 1;
        continue;
      }
      users.set(key, {
        weight: 1,
        item: {
          key,
          mark: u.within ? <SymbolMark kind="" /> : <FileMark path={u.path} />,
          name: u.within ? <span className="mono">{u.within}</span> : <PathText path={u.path} />,
          sub: <PathText path={`${u.path}:${u.line}`} />,
          label: u.within ? `${u.within} in ${u.path}` : u.path,
          open: () =>
            go(
              u.within
                ? { view: "focus", path: u.path, symbol: { name: u.within } }
                : { view: "focus", path: u.path },
            ),
        },
      });
    }
    for (const [key, weight] of weights) joins.push({ from: key, to: symbolKey(s), weight });
  }
  const byUse = [...users.values()]
    .sort((a, b) => b.weight - a.weight)
    .map(({ item, weight }) => ({ ...item, meta: uses(weight) }));
  const left = useCapped(byUse);
  const center: ColumnItem[] = data.symbols.map((s) => ({
    key: symbolKey(s),
    mark: <SymbolMark kind={s.kind} />,
    name: <span className="mono">{s.name}</span>,
    sub: <PathText path={`${s.path}:${s.startLine}`} />,
    ...CHANGE[s.change],
    label: `${s.name}, ${CHANGE[s.change].meta?.toLowerCase()}`,
    ...(s.change === "added"
      ? {}
      : {
          open: () =>
            go({ view: "focus", path: s.path, symbol: { name: s.name, line: s.startLine } }),
        }),
  }));
  const listed = data.symbols.reduce((n, s) => n + s.uses.length, 0);
  const all = data.symbols.reduce((n, s) => n + s.useCount, 0);

  return (
    <div className="graph-work">
      <div className="graph-stage">
        {noticesOf(data).map((n) => (
          <p
            key={n.kind}
            className={`impact-note${n.kind === "behind" || n.kind === "cut" ? " warn" : ""}`}
          >
            {n.kind === "building"
              ? `Building the graph of ${short(n.commit)}. The impact appears when it finishes.`
              : n.kind === "failed"
                ? `The graph of ${short(n.commit)} could not be built.`
                : n.kind === "unreviewed"
                  ? "ocra works out what a pull request reaches when it reviews it here. Review this one to see it."
                  : n.kind === "behind"
                    ? `The graph is of ${short(n.commit)}, not the pull request's base. Some uses may be missing or moved.`
                    : "The platform cut this repository's file list short, so uses past the cut are missing."}
          </p>
        ))}
        {data.symbols.length === 0 ? (
          data.graph && <EmptyNote>The pull request changes no symbol the graph knows.</EmptyNote>
        ) : (
          <ColumnGraph
            label={`What uses the symbols pull request ${pull} changes`}
            left={{
              title: `Used by · ${byUse.length.toLocaleString()}`,
              empty: "Nothing outside the pull request uses them.",
              ...left,
            }}
            center={{
              title: `Changed · ${data.symbols.length.toLocaleString()}`,
              items: center,
              empty: "",
              ...(data.more > 0
                ? { more: <span className="graph-quiet">{data.more} more not listed</span> }
                : {}),
            }}
            joins={joins}
          />
        )}
      </div>
      <aside className="card graph-details" aria-label="Details">
        <div className="card-head graph-details-head">
          <div className="grow">
            <h2>Pull request {pull}</h2>
            <div className="subtle small">
              {data.symbols.length} changed symbol{data.symbols.length === 1 ? "" : "s"} ·{" "}
              {uses(all)}
              {all > listed ? `, ${listed} listed` : ""}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={
              <Link to={`/pull/${repo.platform}/${encodeURIComponent(repo.fullName)}/${pull}`} />
            }
          >
            Open
          </Button>
        </div>
        <h3 className="graph-section">Uses, by changed symbol</h3>
        {data.symbols.map((s) => (
          <section key={symbolKey(s)} className="graph-group">
            <div className="graph-group-head">
              <SymbolMark kind={s.kind} />
              <span className="mono graph-row-name">{s.name}</span>
              <span className="graph-row-meta">{uses(s.useCount)}</span>
            </div>
            {s.uses.length === 0 ? (
              <p className="graph-quiet">No uses outside the pull request.</p>
            ) : (
              <ul className="graph-rows">
                {s.uses.map((u) => (
                  <li key={`${u.path}:${u.line}`}>
                    <a
                      className="graph-row"
                      href={lineUrl(repo, data.graph?.commit ?? "", u.path, u.line)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <FileMark path={u.path} />
                      <PathText path={`${u.path}:${u.line}`} />
                      <span className="graph-row-meta">
                        {u.within ? `in ${u.within}` : "top level"}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </aside>
    </div>
  );
}
