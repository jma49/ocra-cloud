import Zap from "lucide-react/icons/zap";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  AutomationRuleView,
  AutomationRunView,
  AutoReviewRepoView,
  NotifyChannelView,
} from "../../../src/shared/index.js";
import type { Me } from "../api.js";
import { api } from "../api.js";
import { ruleSummary } from "../automations/describe.js";
import { DryRun } from "../automations/dry-run.js";
import { type Choice, RuleForm } from "../automations/rule-form.js";
import { Runs } from "../automations/runs.js";
import { AddGlyph } from "../glyphs.js";
import {
  ActionError,
  EmptyState,
  LoadError,
  Loading,
  PageHead,
  useAction,
  useLoad,
} from "../ui.js";

// Rules the account sets for its pull requests: when one is queued or
// reviewed, and it matches, ocra labels it, asks reviewers, comments,
// notifies a chat or skips the review.

const MAX_RULES = 50;

export function Automations(props: { me: Me }) {
  const queued = props.me.autoReview;
  const rules = useLoad(() => api<{ rules: AutomationRuleView[] }>("/automations/rules"));
  const runs = useLoad(() => api<{ runs: AutomationRunView[] }>("/automations/runs"));
  const channels = useLoad(() => api<{ channels: NotifyChannelView[] }>("/notifications/channels"));
  const repos = useLoad(
    () =>
      queued
        ? api<{ repos: AutoReviewRepoView[] }>("/auto-review/repos")
        : Promise.resolve({ repos: [] }),
    [queued],
  );
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const toggle = useAction((r: AutomationRuleView) =>
    api(`/automations/rules/${r.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: r.name,
        enabled: !r.enabled,
        trigger: r.trigger,
        conditions: r.conditions,
        actions: r.actions,
      }),
    }),
  );
  const remove = useAction((id: string) => api(`/automations/rules/${id}`, { method: "DELETE" }));

  const repoChoices: Choice[] | null = queued
    ? (repos.data?.repos ?? []).map((r) => ({ id: r.id, label: r.fullName }))
    : null;
  const channelChoices: Choice[] = (channels.data?.channels ?? []).map((c) => ({
    id: c.id,
    label: c.name,
  }));
  const names = {
    repo: (id: string) => repoChoices?.find((r) => r.id === id)?.label ?? "a removed repository",
    channel: (id: string) => channelChoices.find((c) => c.id === id)?.label ?? "a removed channel",
  };
  const after = async (p: Promise<unknown>) => {
    if ((await p) !== undefined) rules.reload();
  };
  const form = (rule?: AutomationRuleView) => (
    <RuleForm
      rule={rule}
      queued={queued}
      repos={repoChoices}
      channels={channelChoices}
      done={(saved) => {
        setEditing(null);
        if (saved) rules.reload();
      }}
    />
  );
  const list = rules.data?.rules ?? [];

  return (
    <>
      <PageHead
        title="Automations"
        sub={
          queued
            ? "Rules for your pull requests: when one is queued or reviewed and matches, ocra labels it, asks reviewers, comments, notifies a chat or skips the review."
            : "Rules for your reviews: when one is uploaded and matches, ocra notifies a chat. Labels, reviewer requests and comments need a self-hosted server."
        }
        actions={
          <Button
            type="button"
            disabled={list.length >= MAX_RULES}
            onClick={() => setEditing("new")}
          >
            <AddGlyph size={14} /> New rule
          </Button>
        }
      />
      {toggle.error !== null && <ActionError what="change the rule" error={toggle.error} />}
      {remove.error !== null && <ActionError what="remove the rule" error={remove.error} />}
      {list.some((r) => !r.runsHere) && (
        <p className="note">
          Labels, reviewer requests and comments are written as the ocra bot, which only a
          self-hosted server has. Here those actions are skipped and their runs say so.
        </p>
      )}
      {editing !== null && form(list.find((r) => r.id === editing))}
      {rules.error && !rules.data ? (
        <LoadError what="your rules" error={rules.error} retry={rules.reload} />
      ) : !rules.data ? (
        <Loading what="rules" />
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Zap}
            title="No rules yet"
            action={
              editing === null && (
                <Button variant="outline" onClick={() => setEditing("new")}>
                  Write your first rule
                </Button>
              )
            }
          >
            A rule checks each pull request against its conditions and acts when they all hold, for
            example notifying #payments when a review finds something critical.
          </EmptyState>
        </div>
      ) : (
        list.length > 0 && (
          <div className="card rule-list">
            {list.map((r) => (
              <div className="list-row" key={r.id}>
                <Switch
                  aria-label={`${r.name} on`}
                  checked={r.enabled}
                  disabled={toggle.busy}
                  onCheckedChange={() => after(toggle.run(r))}
                />
                <div className={r.enabled ? "grow" : "grow rule-off"}>
                  <div className="strong">{r.name}</div>
                  <div className="subtle small">{ruleSummary(r, names)}</div>
                </div>
                {!r.runsHere && <span className="badge hide-narrow">Self-hosted actions</span>}
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(r.id)}>
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="destructive-outline"
                  size="sm"
                  disabled={remove.busy}
                  onClick={() => after(remove.run(r.id))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )
      )}
      {list.length > 0 && <DryRun queued={queued} repos={repoChoices} />}
      <div className="card section">
        <div className="card-head">
          <h2>Recent runs</h2>
        </div>
        {runs.error && !runs.data ? (
          <LoadError what="the runs" error={runs.error} retry={runs.reload} inCard />
        ) : !runs.data ? (
          <Loading what="runs" />
        ) : (
          <Runs runs={runs.data.runs} />
        )}
      </div>
    </>
  );
}
