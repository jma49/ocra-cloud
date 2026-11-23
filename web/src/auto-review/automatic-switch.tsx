import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { AutoReviewRepoView, AutoReviewSwitchView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

/** Whether a repository's pull requests are reviewed as they open or gain commits, or only when asked. */
export function AutomaticSwitch(props: { r: AutoReviewRepoView }) {
  const [on, setOn] = useState(props.r.automatic);
  const save = useAction((next: boolean) =>
    api<AutoReviewSwitchView>(`/auto-review/repos/${encodeURIComponent(props.r.id)}/automatic`, {
      method: "PUT",
      body: JSON.stringify({ automatic: next }),
    }),
  );
  const change = async (next: boolean) => {
    setOn(next);
    const saved = await save.run(next);
    setOn(saved ? saved.automatic : !next);
  };
  return (
    <div className="profile-menu">
      <span className="with-mark">
        <Switch
          aria-label={`Review ${props.r.fullName} automatically`}
          checked={on}
          disabled={save.busy}
          onCheckedChange={change}
        />
        <span className="subtle small">{on ? "Every pull request" : "Only when asked"}</span>
      </span>
      {save.error !== null && <ActionError what="change it" error={save.error} />}
    </div>
  );
}
