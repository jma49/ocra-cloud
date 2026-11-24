import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { AutoReviewMendView, AutoReviewRepoView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

// How far ocra goes with a fix a person asks for in this repository: it
// proposes the fix for a person to commit, or commits it to the pull
// request's branch itself. Off until the repository turns it on, since the
// bot then writes to contributors' branches.

export function RepoMend(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const [commits, setCommits] = useState(r.mend === "commit");
  const save = useAction((next: boolean) =>
    api<AutoReviewMendView>(`/auto-review/repos/${encodeURIComponent(r.id)}/mend`, {
      method: "PUT",
      body: JSON.stringify({ mend: next ? "commit" : "propose" }),
    }),
  );
  const change = async (next: boolean) => {
    setCommits(next);
    const saved = await save.run(next);
    setCommits(saved ? saved.mend === "commit" : !next);
    if (saved) props.onChanged();
  };
  return (
    <section className="repo-token stack" aria-label={`Fixes in ${r.fullName}`}>
      <div className="strong">Fixes</div>
      <div className="with-mark restack-switch">
        <Switch
          aria-label={`Commit ocra's fixes in ${r.fullName} to the branch`}
          checked={commits}
          disabled={save.busy}
          onCheckedChange={change}
        />
        <span>When someone asks ocra to fix a finding, commit the fix to the branch</span>
      </div>
      <p className="muted small m-0">
        {commits
          ? "ocra checks each fix, then commits it to the pull request's branch as the ocra bot. It runs nothing from the repository: the pull request's own checks test the commit. It never force-pushes, approves or merges."
          : "ocra proposes each fix on the pull request, and a person commits it."}
      </p>
      {save.error !== null && <ActionError what="change it" error={save.error} />}
    </section>
  );
}
