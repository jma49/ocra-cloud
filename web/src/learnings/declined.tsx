import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import type {
  AutoReviewLearnView,
  CodePlatformKind,
  DeclinedLearningView,
  LearnJobView,
  LearnMode,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ago } from "../format.js";
import { pullPath } from "../pull/path.js";
import { Link } from "../router.js";
import { ActionError, useAction } from "../ui.js";

// What a repository the server reviews does with the findings people
// decline in their threads, and the pull requests it is reading them from.

const MODE: Record<LearnMode, { name: string; says: string }> = {
  merge: {
    name: "Merge when checks pass",
    says: "ocra opens a pull request with the learnings, which merges once its checks pass.",
  },
  propose: {
    name: "Open a pull request",
    says: "ocra opens a pull request with the learnings and leaves it for a person to merge.",
  },
  off: { name: "Off", says: "Declined findings are not read." },
};

const ORDER: readonly LearnMode[] = ["merge", "propose", "off"];

function status(j: LearnJobView): string {
  if (j.state === "queued") return "Waiting to be read";
  if (j.state === "running") return "Reading its threads";
  const when = j.finishedAt ? ` ${ago(j.finishedAt)}` : "";
  return j.state === "failed" ? `Could not be read${when}` : `Read${when}`;
}

export function DeclinedLearning(props: {
  platform: CodePlatformKind;
  repo: string;
  data: DeclinedLearningView;
}) {
  const { data } = props;
  const [learn, setLearn] = useState(data.learn);
  const save = useAction((next: LearnMode) =>
    api<AutoReviewLearnView>(`/auto-review/repos/${encodeURIComponent(data.reviewRepoId)}/learn`, {
      method: "PUT",
      body: JSON.stringify({ learn: next }),
    }),
  );
  const change = async (next: LearnMode) => {
    const saved = await save.run(next);
    if (saved) setLearn(saved.learn);
  };
  return (
    <div className="card section">
      <div className="card-head">
        <h3>From declined findings</h3>
        <Menu>
          <MenuTrigger
            render={<Button type="button" variant="outline" size="sm" loading={save.busy} />}
            aria-label={`Learning from declined findings: ${MODE[learn].name}`}
          >
            {MODE[learn].name}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup value={learn} onValueChange={(next) => change(next as LearnMode)}>
              {ORDER.map((m) => (
                <MenuRadioItem key={m} value={m} className="profile-item">
                  <span className="strong">{MODE[m].name}</span>
                  <span className="subtle small">{MODE[m].says}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </div>
      <p className="subtle small card-pad m-0">
        {learn === "off"
          ? "Switched off for this repository."
          : "When someone with write access declines a finding in its thread and says why, ocra drafts a learning from the reason a few minutes later."}
      </p>
      {save.error !== null && <ActionError what="change it" error={save.error} />}
      {data.jobs.map((j) => (
        <div className="list-row" key={j.number}>
          <span className="grow">
            <Link to={pullPath(props.platform, props.repo, j.number)}>#{j.number}</Link>{" "}
            <span className={j.state === "failed" ? "error-inline small" : "subtle small"}>
              {status(j)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
