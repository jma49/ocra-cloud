import type { AutomationPaths } from "../../../src/shared/index.js";
import { listOf, Row } from "../form.js";

// A rule's condition on the files a pull request changes: globs to take,
// globs to leave out, and whether one selected file is enough.

export type PathsDraft = { include: string; exclude: string; every: boolean };

export const pathsDraft = (p: AutomationPaths | undefined): PathsDraft => ({
  include: p?.include?.join(", ") ?? "",
  exclude: p?.exclude?.join(", ") ?? "",
  every: p?.every ?? false,
});

/** The condition a draft says; undefined when it names no glob, so the rule tests no files. */
export function pathsOf(d: PathsDraft): AutomationPaths | undefined {
  const include = listOf(d.include);
  const exclude = listOf(d.exclude);
  if (!include && !exclude) return undefined;
  return { include, exclude, ...(d.every ? { every: true } : {}) };
}

export function PathsRow(props: { value: PathsDraft; onChange: (d: PathsDraft) => void }) {
  const d = props.value;
  const set = (change: Partial<PathsDraft>) => props.onChange({ ...d, ...change });
  return (
    <Row
      label="Changed files"
      desc="Globs as in .gitignore, comma-separated: src/payments/**, *.sql. Empty tests no files."
    >
      <div className="stack">
        <input
          className="input mono"
          aria-label="Changed files to match"
          placeholder="src/payments/**, *.sql"
          value={d.include}
          onChange={(e) => set({ include: e.target.value })}
        />
        <input
          className="input mono"
          aria-label="Changed files to leave out"
          placeholder="except: **/*.test.ts, docs/**"
          value={d.exclude}
          onChange={(e) => set({ exclude: e.target.value })}
        />
        <label className="check small">
          <input
            type="checkbox"
            checked={d.every}
            onChange={(e) => set({ every: e.target.checked })}
          />
          Every changed file must match, not just one
        </label>
      </div>
    </Row>
  );
}
