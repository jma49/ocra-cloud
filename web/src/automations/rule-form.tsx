import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  AutomationAction,
  AutomationActionKind,
  AutomationConditions,
  AutomationRuleView,
  AutomationTrigger,
  Verdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { listOf, Row } from "../form.js";
import { AddGlyph, CloseGlyph } from "../glyphs.js";
import { Seg, useAction } from "../ui.js";
import { ACTION_LABEL, actionsFor, VERDICT_LABEL, VERDICT_LIST } from "./describe.js";

// One rule, new or changed: its trigger, the conditions that trigger may
// test, and up to five actions it may take. The form offers only what the
// trigger allows, since the server refuses the rest.

export type Choice = { id: string; label: string };
type Draft = { key: number; kind: AutomationActionKind; text: string };

const MAX_ACTIONS = 5;
const HINT: Partial<Record<AutomationActionKind, string>> = {
  add_labels: "needs-review, payments",
  request_reviewers: "octocat, hubot",
  comment: "Plain text, posted as the ocra bot",
};

let nextKey = 0;
const draftOf = (a: AutomationAction): Draft => ({
  key: nextKey++,
  kind: a.kind,
  text:
    a.kind === "add_labels"
      ? a.labels.join(", ")
      : a.kind === "request_reviewers"
        ? a.reviewers.join(", ")
        : a.kind === "comment"
          ? a.body
          : a.kind === "notify"
            ? a.channelId
            : "",
});

function actionOf(d: Draft): AutomationAction {
  switch (d.kind) {
    case "add_labels":
      return { kind: d.kind, labels: listOf(d.text) ?? [] };
    case "request_reviewers":
      return { kind: d.kind, reviewers: listOf(d.text) ?? [] };
    case "comment":
      return { kind: d.kind, body: d.text };
    case "notify":
      return { kind: d.kind, channelId: d.text };
    case "skip_review":
      return { kind: d.kind };
  }
}

export function RuleForm(props: {
  rule?: AutomationRuleView | undefined;
  /** Whether this server queues pull requests itself, so a rule may run then. */
  queued: boolean;
  /** Enrolled repositories; null where this server does not enroll any. */
  repos: Choice[] | null;
  channels: Choice[];
  done: (saved: boolean) => void;
}) {
  const r = props.rule;
  const c = r?.conditions ?? {};
  const [name, setName] = useState(r?.name ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger>(
    r?.trigger ?? (props.queued ? "queued" : "reviewed"),
  );
  const [repoIds, setRepoIds] = useState(c.repoIds ?? []);
  const [authors, setAuthors] = useState(c.authors?.join(", ") ?? "");
  const [branches, setBranches] = useState(c.baseBranches?.join(", ") ?? "");
  const [title, setTitle] = useState(c.title ?? "");
  const [labels, setLabels] = useState(c.labels?.join(", ") ?? "");
  const [critical, setCritical] = useState(
    c.critical === undefined ? "any" : c.critical ? "yes" : "no",
  );
  const [verdicts, setVerdicts] = useState<Verdict[]>(c.verdicts ?? []);
  const [actions, setActions] = useState<Draft[]>(
    r ? r.actions.map(draftOf) : [{ key: nextKey++, kind: "notify", text: "" }],
  );
  const allowed = actionsFor(trigger);

  const conditions = (): AutomationConditions => ({
    ...(repoIds.length ? { repoIds } : {}),
    ...(trigger === "queued"
      ? {
          authors: listOf(authors),
          baseBranches: listOf(branches),
          title: title.trim() || undefined,
          labels: listOf(labels),
        }
      : {
          critical: critical === "any" ? undefined : critical === "yes",
          verdicts: verdicts.length ? verdicts : undefined,
        }),
  });
  const save = useAction(() =>
    api(r ? `/automations/rules/${r.id}` : "/automations/rules", {
      method: r ? "PUT" : "POST",
      body: JSON.stringify({
        name: name.trim(),
        enabled: r?.enabled ?? true,
        trigger,
        conditions: conditions(),
        actions: actions.map(actionOf),
      }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.run()) !== undefined) props.done(true);
  };
  const changeTrigger = (t: AutomationTrigger) => {
    setTrigger(t);
    setActions((as) => as.filter((a) => actionsFor(t).includes(a.kind)));
  };
  const edit = (key: number, change: Partial<Draft>) =>
    setActions((as) => as.map((a) => (a.key === key ? { ...a, ...change } : a)));
  const ready =
    name.trim() !== "" &&
    actions.length > 0 &&
    actions.every((a) => a.kind === "skip_review" || a.text.trim() !== "");

  return (
    <Drawer
      title={r ? `Edit ${r.name}` : "New rule"}
      heading={r ? `Edit “${r.name}”` : "New rule"}
      onClose={() => props.done(false)}
      onSubmit={submit}
      foot={
        <>
          {save.error !== null && (
            <span className="error small grow" role="alert">
              Could not save it: {why(save.error)}.
            </span>
          )}
          <Button type="button" variant="outline" onClick={() => props.done(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.busy || !ready}>
            {r ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <Row label="Name" desc="How the rule shows here and in its runs.">
        <input
          className="input"
          aria-label="Rule name"
          maxLength={64}
          placeholder="e.g. Payments need two eyes"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Row>
      <Row label="When" desc="The moment the rule is checked.">
        {props.queued ? (
          <Seg
            label="When"
            value={trigger}
            onChange={changeTrigger}
            options={[
              { value: "queued", label: "Queued" },
              { value: "reviewed", label: "Reviewed" },
            ]}
          />
        ) : (
          <span className="muted small">A review is uploaded</span>
        )}
      </Row>
      {props.repos && props.repos.length > 0 && (
        <Row label="Repositories" desc="Any of these; none ticked means every enrolled one.">
          <Checks items={props.repos} value={repoIds} onChange={setRepoIds} what="Repository" />
        </Row>
      )}
      {trigger === "queued" ? (
        <>
          <Row label="Authors" desc="Logins, comma-separated; any of them.">
            <input
              className="input mono"
              aria-label="Authors"
              placeholder="octocat, hubot"
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
            />
          </Row>
          <Row label="Into branch" desc="The branch it merges into; any of them.">
            <input
              className="input mono"
              aria-label="Base branches"
              placeholder="main, release/*"
              value={branches}
              onChange={(e) => setBranches(e.target.value)}
            />
          </Row>
          <Row label="Title" desc="* matches any text, ? one character; case does not matter.">
            <input
              className="input"
              aria-label="Title pattern"
              maxLength={200}
              placeholder="*hotfix*"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Row>
          <Row label="Labels" desc="Any of these labels on it.">
            <input
              className="input"
              aria-label="Labels"
              placeholder="payments, security"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </Row>
        </>
      ) : (
        <>
          <Row label="Critical finding" desc="Whether the review found something critical.">
            <select
              className="input"
              aria-label="Critical finding"
              value={critical}
              onChange={(e) => setCritical(e.target.value)}
            >
              <option value="any">Either way</option>
              <option value="yes">Found one</option>
              <option value="no">Found none</option>
            </select>
          </Row>
          <Row label="Verdict" desc="Any of these; none ticked means any verdict.">
            <Checks
              items={VERDICT_LIST.map((v) => ({ id: v, label: VERDICT_LABEL[v] }))}
              value={verdicts}
              onChange={(v) => setVerdicts(v as Verdict[])}
              what="Verdict"
            />
          </Row>
        </>
      )}
      <div className="rule-actions">
        <div className="label">Then</div>
        {actions.map((a, i) => (
          <div className="rule-action" key={a.key}>
            <select
              className="input"
              aria-label={`Action ${i + 1}`}
              value={a.kind}
              onChange={(e) =>
                edit(a.key, { kind: e.target.value as AutomationActionKind, text: "" })
              }
            >
              {allowed.map((k) => (
                <option key={k} value={k}>
                  {ACTION_LABEL[k]}
                </option>
              ))}
            </select>
            <ActionValue draft={a} channels={props.channels} n={i + 1} edit={edit} />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={`Remove action ${i + 1}`}
              disabled={actions.length === 1}
              onClick={() => setActions((as) => as.filter((x) => x.key !== a.key))}
            >
              <CloseGlyph size={14} />
            </Button>
          </div>
        ))}
        {actions.length < MAX_ACTIONS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="add-action"
            onClick={() =>
              setActions((as) => [...as, { key: nextKey++, kind: "notify", text: "" }])
            }
          >
            <AddGlyph size={14} /> Add an action
          </Button>
        )}
      </div>
    </Drawer>
  );
}

function ActionValue(props: {
  draft: Draft;
  channels: Choice[];
  n: number;
  edit: (key: number, change: Partial<Draft>) => void;
}) {
  const { draft: a } = props;
  const set = (text: string) => props.edit(a.key, { text });
  const label = `${ACTION_LABEL[a.kind]}, action ${props.n}`;
  if (a.kind === "skip_review")
    return <span className="muted small grow">The head is not reviewed.</span>;
  if (a.kind === "notify")
    return props.channels.length === 0 ? (
      <span className="muted small grow">Add a channel under Notifications first.</span>
    ) : (
      <select
        className="input grow"
        aria-label={label}
        value={a.text}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">Choose a channel</option>
        {props.channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    );
  if (a.kind === "comment")
    return (
      <textarea
        className="input grow"
        aria-label={label}
        rows={2}
        maxLength={2000}
        placeholder={HINT.comment}
        value={a.text}
        onChange={(e) => set(e.target.value)}
      />
    );
  return (
    <input
      className="input grow mono"
      aria-label={label}
      placeholder={HINT[a.kind]}
      value={a.text}
      onChange={(e) => set(e.target.value)}
    />
  );
}

function Checks(props: {
  items: Choice[];
  value: string[];
  onChange: (v: string[]) => void;
  what: string;
}) {
  return (
    <div className="check-list">
      {props.items.map((it) => (
        <label className="check" key={it.id}>
          <input
            type="checkbox"
            aria-label={`${props.what} ${it.label}`}
            checked={props.value.includes(it.id)}
            onChange={(e) =>
              props.onChange(
                e.target.checked ? [...props.value, it.id] : props.value.filter((x) => x !== it.id),
              )
            }
          />
          {it.label}
        </label>
      ))}
    </div>
  );
}
