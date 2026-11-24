import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { AutoReviewMendView, AutoReviewRepoView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

// How far ocra goes with a fix in this repository: it proposes the fix for
// a person to commit, or commits it to the pull request's branch itself;
// and, where it commits, whether a failed check starts a fix nobody asked
// for. Both off until the repository turns them on, since the bot then
// writes to contributors' branches.

export function RepoMend(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const [set, setSet] = useState({ commits: r.mend === "commit", checks: r.mendChecks });
  const save = useAction((next: typeof set) =>
    api<AutoReviewMendView>(`/auto-review/repos/${encodeURIComponent(r.id)}/mend`, {
      method: "PUT",
      body: JSON.stringify({ mend: next.commits ? "commit" : "propose", checks: next.checks }),
    }),
  );
  const change = async (next: typeof set) => {
    const before = set;
    setSet(next);
    const saved = await save.run(next);
    setSet(saved ? { commits: saved.mend === "commit", checks: saved.checks } : before);
    if (saved) props.onChanged();
  };
  return (
    <section className="repo-token stack" aria-label={`Fixes in ${r.fullName}`}>
      <div className="strong">Fixes</div>
      <div className="with-mark restack-switch">
        <Switch
          aria-label={`Commit ocra's fixes in ${r.fullName} to the branch`}
          checked={set.commits}
          disabled={save.busy}
          onCheckedChange={(commits) => change({ commits, checks: commits && set.checks })}
        />
        <span>When someone asks ocra to fix a finding, commit the fix to the branch</span>
      </div>
      <p className="muted small m-0">
        {set.commits
          ? "ocra checks each fix, then commits it to the pull request's branch as the ocra bot. It runs nothing from the repository: the pull request's own checks test the commit. It never force-pushes, approves or merges."
          : "ocra proposes each fix on the pull request, and a person commits it."}
      </p>
      {set.commits && (
        <>
          <div className="with-mark restack-switch">
            <Switch
              aria-label={`Fix failed checks in ${r.fullName}`}
              checked={set.checks}
              disabled={save.busy}
              onCheckedChange={(checks) => change({ ...set, checks })}
            />
            <span>When a check fails on a pull request, fix what failed</span>
          </div>
          <p className="muted small m-0">
            {set.checks
              ? "ocra reads the end of the failed job's log and commits a fix when it finds one, without being asked. A check that also fails on the base branch is left alone, and so is one it could not fix in two tries."
              : "ocra fixes only what someone asks it to."}
          </p>
        </>
      )}
      {save.error !== null && <ActionError what="change it" error={save.error} />}
    </section>
  );
}
