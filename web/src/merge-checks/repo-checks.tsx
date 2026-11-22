import { Button } from "@/components/ui/button";
import type { MergeCheckView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, LoadError, Loading, useAction, useLoad } from "../ui.js";
import { AddCheck } from "./add-check.js";
import { KIND_LABEL, settingsText } from "./describe.js";

// An enrolled repository's pre-merge checks: each off, a warning or
// blocking, and the result posted on every pull request's head.

type Mode = MergeCheckView["mode"];
const MODE_LABEL: Record<Mode, string> = { off: "Off", warn: "Warns", block: "Blocks" };

export function RepoChecks(props: { repoId: string; fullName: string }) {
  const base = `/merge-checks/repos/${props.repoId}/checks`;
  const { data, error, reload } = useLoad(() => api<{ checks: MergeCheckView[] }>(base), [base]);
  const change = useAction((id: string, mode: Mode) =>
    api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ mode }) }),
  );
  const remove = useAction((id: string) => api(`${base}/${id}`, { method: "DELETE" }));
  const after = async (p: Promise<unknown>) => {
    if ((await p) !== undefined) reload();
  };
  return (
    <section className="repo-checks stack" aria-label={`Pre-merge checks of ${props.fullName}`}>
      <div className="strong">Pre-merge checks</div>
      {change.error !== null && <ActionError what="change the check" error={change.error} />}
      {remove.error !== null && <ActionError what="remove the check" error={remove.error} />}
      {error && !data ? (
        <LoadError what="the checks" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="checks" />
      ) : data.checks.length === 0 ? (
        <p className="subtle small m-0">
          No checks yet. Each one you add is posted on every pull request's head as one check.
        </p>
      ) : (
        <ul className="check-rows">
          {data.checks.map((c) => (
            <li key={c.id}>
              <div className="grow">
                <span className="strong">{KIND_LABEL[c.kind]}</span>{" "}
                <span className="muted">{settingsText(c)}</span>
              </div>
              <select
                className="input"
                aria-label={`${KIND_LABEL[c.kind]} mode`}
                value={c.mode}
                disabled={change.busy}
                onChange={(e) => after(change.run(c.id, e.target.value as Mode))}
              >
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={remove.busy}
                onClick={() => after(remove.run(c.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AddCheck repoId={props.repoId} onAdded={reload} />
    </section>
  );
}
