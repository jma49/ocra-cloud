import Network from "lucide-react/icons/network";
import { Button } from "@/components/ui/button";
import type { GraphRepoView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { FocusView } from "../code-graph/focus-view.js";
import { ImpactGraph } from "../code-graph/impact-view.js";
import { FolderMap } from "../code-graph/map-view.js";
import { baseOf, dirOf } from "../code-graph/marks.js";
import { type GraphPlace, useGraphPlace } from "../code-graph/place.js";
import { GraphSearch } from "../code-graph/search.js";
import { type GraphLoad, useGraph } from "../code-graph/use-graph.js";
import { bytes, count } from "../format.js";
import { short } from "../impact/select.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead } from "../ui.js";

// One repository's code graph, to explore: a folder's map, a file's or a
// symbol's neighbours, or what a pull request's change reaches. The graph is
// read once into a worker in the browser; the server only sends it.

type Repos = { repos: GraphRepoView[] };

export function CodeGraph(props: { id: string }) {
  const repos = useCached("/graphs/repos", () => api<Repos>("/graphs/repos"));
  const repo = repos.data?.repos.find((r) => r.id === props.id);
  if (repos.error && !repos.data) {
    return (
      <>
        <PageHead title="Code graph" />
        <LoadError what="the code graph" error={repos.error} retry={repos.reload} />
      </>
    );
  }
  if (!repos.data) {
    return (
      <>
        <PageHead title="Code graph" />
        <Loading what="the code graph" />
      </>
    );
  }
  if (!repo) {
    return (
      <>
        <PageHead title="Code graph" />
        <div className="card">
          <EmptyState icon={Network} title="This code graph is not kept" action={<BackToList />}>
            The repository may have been removed from Code graphs.
          </EmptyState>
        </div>
      </>
    );
  }
  return <Explorer repo={repo} />;
}

const BackToList = () => (
  <Button variant="outline" render={<Link to="/code-graphs" />}>
    Back to code graphs
  </Button>
);

function Explorer(props: { repo: GraphRepoView }) {
  const { repo } = props;
  const graph = useGraph(repo.id);
  const [place, go] = useGraphPlace();
  const ready = graph.state === "ready" ? graph : null;
  return (
    <div className="graph-page">
      <PageHead
        title={repo.fullName}
        sub={
          ready ? (
            <>
              {repo.branch} at <span className="mono">{short(ready.commit)}</span> ·{" "}
              {count(ready.files, "file")} · {count(ready.symbols, "symbol")}. Uses are matched to
              definitions by name, not resolved by type.
            </>
          ) : (
            `The default branch, ${repo.branch}, as the newest graph has it.`
          )
        }
        actions={ready ? <GraphSearch client={ready.client} go={go} /> : undefined}
      />
      {!(place.view === "map" && place.folder === "") && (
        <Trail repo={repo} place={place} go={go} />
      )}
      {place.view === "impact" ? (
        <ImpactGraph repo={repo} pull={place.pull} go={go} />
      ) : !ready ? (
        <LoadState load={graph} />
      ) : place.view === "map" ? (
        <FolderMap client={ready.client} folder={place.folder} go={go} />
      ) : (
        <FocusView client={ready.client} repo={repo} commit={ready.commit} place={place} go={go} />
      )}
    </div>
  );
}

function LoadState(props: { load: GraphLoad }) {
  const { load } = props;
  if (load.state === "failed") {
    return (
      <div className="card">
        {load.status === 404 ? (
          <EmptyState icon={Network} title="No graph built yet" action={<BackToList />}>
            Its first graph appears once a build of the default branch finishes.
          </EmptyState>
        ) : (
          <EmptyState icon={Network} title="The graph could not be read" action={<BackToList />}>
            {load.status === 422
              ? "It was built by a version of ocra this console does not read. Rebuild it."
              : "Reload the page to try again."}
          </EmptyState>
        )}
      </div>
    );
  }
  return (
    <div className="card graph-loading" role="status">
      <span className="shimmer-text">
        {load.state === "indexing"
          ? "Indexing the graph…"
          : `Reading the graph…${load.state === "reading" && load.bytes > 0 ? ` ${bytes(load.bytes)}` : ""}`}
      </span>
    </div>
  );
}

/** Where the view stands: the folders down to it, each a step back up to its map. */
function Trail(props: { repo: GraphRepoView; place: GraphPlace; go: (to: GraphPlace) => void }) {
  const { place, go } = props;
  const path =
    place.view === "map" ? place.folder : place.view === "focus" ? dirOf(place.path) : "";
  const folders = path ? path.split("/") : [];
  const step = (label: string, to: GraphPlace | null, mono = true) => (
    <li key={`${label}:${JSON.stringify(to)}`}>
      {to ? (
        <button type="button" className={`graph-step${mono ? " mono" : ""}`} onClick={() => go(to)}>
          {label}
        </button>
      ) : (
        <span className={`graph-step here${mono ? " mono" : ""}`} aria-current="location">
          {label}
        </span>
      )}
    </li>
  );
  const last = place.view === "map" ? folders.length - 1 : -2;
  return (
    <nav className="graph-trail" aria-label="Where in the graph">
      <ol>
        {step(
          place.view === "impact" ? "Map" : props.repo.fullName,
          place.view === "map" && folders.length === 0 ? null : { view: "map", folder: "" },
          false,
        )}
        {folders.map((f, i) =>
          step(f, i === last ? null : { view: "map", folder: folders.slice(0, i + 1).join("/") }),
        )}
        {place.view === "focus" &&
          step(baseOf(place.path), place.symbol ? { view: "focus", path: place.path } : null)}
        {place.view === "focus" && place.symbol && step(place.symbol.name, null)}
        {place.view === "impact" && step(`Pull request ${place.pull}`, null, false)}
      </ol>
    </nav>
  );
}
