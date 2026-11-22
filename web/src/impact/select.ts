import type { GraphRepoView, ImpactSymbol, ImpactView } from "../../../src/shared/index.js";

// The impact rail's rules, apart from its markup: which graph a review's
// pull request is read from, which changed symbols a finding is about, and
// what the rail says about the graph it shows.

/** The graph repository of a pull request's repository, as the CLI names it (ADR-0038). */
export function graphRepoOf(
  repos: readonly GraphRepoView[],
  repository: string,
): GraphRepoView | undefined {
  const wanted = repository.toLowerCase();
  return repos.find((r) => r.identity === wanted);
}

type Placed = { file: string; lineStart: number | null };

/** The changed symbols a finding sits in: those whose changed lines hold its line, in its file. */
export function symbolsOf(symbols: readonly ImpactSymbol[], finding: Placed): ImpactSymbol[] {
  const line = finding.lineStart;
  return symbols.filter(
    (s) =>
      s.path === finding.file &&
      (line === null || s.lines.some(([start, end]) => start <= line && line <= end)),
  );
}

export type RailNotice =
  | { kind: "building"; commit: string }
  | { kind: "failed"; commit: string }
  | { kind: "behind"; commit: string }
  | { kind: "cut" };

/** What the rail says before its list, most pressing first. */
export function noticesOf(view: ImpactView): RailNotice[] {
  const out: RailNotice[] = [];
  const build = view.build;
  if (!view.graph && build) {
    out.push({
      kind: build.state === "failed" ? "failed" : "building",
      commit: build.commit,
    });
  }
  if (view.graph && !view.graph.current) out.push({ kind: "behind", commit: view.graph.commit });
  if (view.graph?.truncated) out.push({ kind: "cut" });
  return out;
}

/** Where the platform shows a file at a commit and line, from the graph repository's own names. */
export function lineUrl(repo: GraphRepoView, commit: string, path: string, line: number): string {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const blob = repo.platform === "gitlab" ? "-/blob" : "blob";
  return `${repo.url}/${blob}/${commit}/${file}#L${line}`;
}

export const short = (commit: string) => commit.slice(0, 7);
