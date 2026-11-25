import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { SetupCheck, SetupSettingName, SetupSettingsView } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { useToast } from "../toast.js";
import { ActionError, Seg, useAction } from "../ui.js";
import { CheckList } from "./checks.js";
import { type FieldDef, type FormDef, GITHUB, GITLAB, MODELS } from "./steps.js";

// A step's form: its fields as saved (a secret only as set), a test of the
// connection with what is typed, and Save. A field the server's environment
// sets is shown locked: the environment wins.

type Values = Partial<Record<SetupSettingName, string | null>>;

export function StepForm(props: {
  title: string;
  sub: string;
  form: FormDef;
  view: SetupSettingsView;
  onSaved: (view: SetupSettingsView) => void;
  /** A choice in the card's head, beside its title. */
  choice?: ReactNode;
  /** Settings the step sets with controls of its own, saved and tested with the fields. */
  extra?: { values: Values; controls: ReactNode };
}) {
  const { form, view } = props;
  const toast = useToast();
  const [draft, setDraft] = useState<Values>({});
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);

  const values = (): Values => {
    const out: Values = { ...props.extra?.values };
    for (const f of form.fields) {
      const typed = draft[f.name];
      if (typed === undefined || view.fields[f.name].lockedBy) continue;
      // A secret left blank keeps the saved one.
      if (f.kind === "secret" && !typed) continue;
      out[f.name] = typed || null;
    }
    return out;
  };
  const save = useAction(() =>
    api<SetupSettingsView>("/setup/settings", {
      method: "PUT",
      body: JSON.stringify({ values: values() }),
    }),
  );
  const test = useAction(() =>
    api<{ checks: SetupCheck[] }>("/setup/check", {
      method: "POST",
      body: JSON.stringify({ step: form.check, values: { ...shownValues(), ...values() } }),
    }),
  );
  /** What the fields hold now, typed or saved, for a test: secrets the server fills in. */
  const shownValues = (): Values =>
    Object.fromEntries(
      form.fields.flatMap((f) => {
        const value = view.fields[f.name].value;
        return value !== undefined ? [[f.name, value]] : [];
      }),
    );

  const onSave = async (e: React.SubmitEvent) => {
    e.preventDefault();
    const next = await save.run();
    if (!next) return;
    setDraft({});
    props.onSaved(next);
    toast("Saved", "success");
  };
  const onTest = async () => {
    setChecks(null);
    const answer = await test.run();
    if (answer) setChecks(answer.checks);
  };
  const issues = save.error instanceof ApiError ? save.error.issues : [];

  return (
    <form className="card setup-step" onSubmit={onSave} noValidate>
      <div className="card-head">
        <h2>{props.title}</h2>
        {props.choice}
      </div>
      <div className="card-pad">
        <p className="muted m-0">{props.sub}</p>
        {form.address && (
          <dl className="kv setup-addresses">
            {form.address.map((a) => (
              <Address key={a.of} label={a.label} value={view.addresses[a.of]} />
            ))}
          </dl>
        )}
        {props.extra?.controls}
        {form.fields.map((f) => (
          <Field
            key={f.name}
            def={f}
            field={view.fields[f.name]}
            typed={draft[f.name]}
            issue={issues.find((i) => i.path[0] === f.name)?.message}
            onChange={(value) => setDraft((d) => ({ ...d, [f.name]: value }))}
          />
        ))}
        {issues
          .filter((i) => i.path.length === 0)
          .map((i) => (
            <p key={i.message} className="note err" role="alert">
              The server would not start with these settings: {i.message}.
            </p>
          ))}
        {save.error !== null && issues.length === 0 && (
          <ActionError what="save the settings" error={save.error} />
        )}
        {test.error !== null && <ActionError what="test the connection" error={test.error} />}
        {checks && <CheckList checks={checks} />}
      </div>
      <div className="setup-actions">
        {form.check && (
          <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={test.busy}>
            {test.busy ? "Testing…" : "Test connection"}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={save.busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Field(props: {
  def: FieldDef;
  field: SetupSettingsView["fields"][SetupSettingName];
  typed: string | null | undefined;
  issue: string | undefined;
  onChange: (value: string) => void;
}) {
  const { def, field } = props;
  const id = `setting-${def.name}`;
  const locked = field.lockedBy;
  const value = props.typed ?? (def.kind === "secret" ? "" : (field.value ?? ""));
  const placeholder =
    def.kind === "secret" && field.set ? "Saved: type to replace it" : def.placeholder;
  const hint = locked ? `Set by ${locked} in the server's environment, which wins.` : def.hint;
  const common = {
    id,
    className: `input${def.kind === "mono" || def.kind === "textarea" ? " mono" : ""}`,
    value,
    disabled: !!locked,
    placeholder,
    spellCheck: false,
    autoComplete: "off",
    "aria-invalid": props.issue ? true : undefined,
    "aria-describedby": hint || props.issue ? `${id}-hint` : undefined,
  } as const;
  return (
    <div className="field">
      <label htmlFor={id}>{def.label}</label>
      {def.kind === "textarea" ? (
        <textarea {...common} rows={5} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={def.kind === "secret" ? "password" : "text"}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      {(props.issue || hint) && (
        <span id={`${id}-hint`} className={props.issue ? "hint error" : "hint"}>
          {props.issue ? `${capital(props.issue)}.` : hint}
        </span>
      )}
    </div>
  );
}

function Address(props: { label: string; value: string }) {
  const toast = useToast();
  return (
    <>
      <dt>{props.label}</dt>
      <dd className="setup-address">
        <code className="mono">{props.value}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigator.clipboard.writeText(props.value).then(() => toast("Copied"))}
        >
          Copy
        </Button>
      </dd>
    </>
  );
}

export function CodeHostForm(props: {
  view: SetupSettingsView;
  onSaved: (view: SetupSettingsView) => void;
}) {
  const githubSet = ["github.clientId", "github.appId"].some(
    (n) => props.view.fields[n as SetupSettingName].set,
  );
  const gitlabSet = props.view.fields["gitlab.url"].set;
  const [host, setHost] = useState<"gitlab" | "github">(
    githubSet && !gitlabSet ? "github" : "gitlab",
  );
  const choice = (
    <Seg
      label="Code host"
      value={host}
      onChange={setHost}
      options={[
        { value: "gitlab", label: "GitLab" },
        { value: "github", label: "GitHub" },
      ]}
    />
  );
  return host === "gitlab" ? (
    <StepForm
      key="gitlab"
      title="Code host"
      sub="Your self-managed GitLab: people connect it to see their merge requests here, and the review bot posts ocra's reviews."
      form={GITLAB}
      choice={choice}
      {...props}
    />
  ) : (
    <StepForm
      key="github"
      title="Code host"
      sub="A GitHub App of your own, on github.com or your GitHub Enterprise Server: people sign in and connect repositories with it, and it posts ocra's reviews."
      form={GITHUB}
      choice={choice}
      {...props}
    />
  );
}

export function ModelsForm(props: {
  view: SetupSettingsView;
  onSaved: (view: SetupSettingsView) => void;
}) {
  const fields = props.view.fields;
  const [wire, setWire] = useState(fields["models.wire"].value ?? "openai");
  const [builtin, setBuiltin] = useState(fields["models.builtin"].value === "on");
  const values: Values = {};
  if (!fields["models.wire"].lockedBy) values["models.wire"] = wire;
  if (!fields["models.builtin"].lockedBy) values["models.builtin"] = builtin ? "on" : "off";
  return (
    <StepForm
      title="Models"
      sub="The model gateway reviews run on. Every account uses its key, so nobody brings their own; the spend of each call is recorded per person."
      form={MODELS}
      extra={{
        values,
        controls: (
          <>
            <div className="field">
              <span className="setup-label" id="setup-wire">
                What the gateway speaks
              </span>
              <Seg
                label="What the gateway speaks"
                value={wire}
                onChange={setWire}
                options={[
                  { value: "openai", label: "OpenAI API" },
                  { value: "anthropic", label: "Anthropic API" },
                ]}
              />
            </div>
            <div className="field setup-switch">
              <Switch
                id="setup-builtin"
                checked={builtin}
                onCheckedChange={setBuiltin}
                disabled={!!fields["models.builtin"].lockedBy}
              />
              <label htmlFor="setup-builtin">
                Also offer public providers, with each person's own key
              </label>
            </div>
          </>
        ),
      }}
      {...props}
    />
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
