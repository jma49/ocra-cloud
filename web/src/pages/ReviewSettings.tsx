import { GlobList, NumberField, Row, TriSwitch, withOptional } from "../form.js";
import { usePrefs, useSettings } from "../prefs.js";
import { PageHead } from "../ui.js";

// Limits, checking and file selection (ADR-0027). Each applies only where
// the repository's .ocra/config.json leaves it out; lists combine with it.

export function ReviewSettings() {
  const { draft } = usePrefs();
  const { settings, set } = useSettings();
  // The fields start from the saved values, so they wait for them.
  if (!draft) return <PageHead title="Review settings" />;
  const sampling = settings.sampling ?? {};
  return (
    <>
      <PageHead
        title="Review settings"
        sub="Your defaults for every signed-in review. A repository's .ocra/config.json wins for anything it sets; file lists combine with it."
      />

      <div className="card">
        <div className="card-head">
          <h2>Cost and limits</h2>
          <span className="subtle small">A repository's limit always wins over yours.</span>
        </div>
        <Row
          label="Spend limit per review"
          desc="Stops starting tasks past it and reports what it left; reviews use 80%, checking the rest."
        >
          <NumberField
            label="Spend limit"
            value={settings.maxCostUsd}
            placeholder="none"
            min={0.01}
            max={1000}
            unit="USD"
            onChange={(v) => set("maxCostUsd", v)}
          />
        </Row>
        <Row
          label="Most review tasks"
          desc="Past it, later reviewers are skipped and their files reported as not reviewed."
        >
          <NumberField
            label="Most review tasks"
            value={settings.maxTasks}
            placeholder="60"
            min={1}
            max={1000}
            onChange={(v) => set("maxTasks", v && Math.round(v))}
          />
        </Row>
        <Row label="Tasks at once" desc="Review tasks running in parallel (1–32).">
          <NumberField
            label="Tasks at once"
            value={settings.concurrency}
            placeholder="8"
            min={1}
            max={32}
            onChange={(v) => set("concurrency", v && Math.round(v))}
          />
        </Row>
        <Row label="Task time limit" desc="A task past it fails; its files are reported as failed.">
          <NumberField
            label="Task time limit"
            value={settings.taskTimeoutMinutes}
            placeholder="10"
            min={1}
            max={600}
            unit="min"
            onChange={(v) => set("taskTimeoutMinutes", v)}
          />
        </Row>
        <Row label="Review time limit" desc="The whole run stops and writes a partial report.">
          <NumberField
            label="Review time limit"
            value={settings.runTimeoutMinutes}
            placeholder="25"
            min={1}
            max={600}
            unit="min"
            onChange={(v) => set("runTimeoutMinutes", v)}
          />
        </Row>
      </div>

      <div className="section card">
        <div className="card-head">
          <h2>Checking findings</h2>
        </div>
        <Row label="Verify" desc="Fact-check each finding against the code before reporting it.">
          <TriSwitch
            label="Verify findings"
            value={settings.verify}
            fallback={true}
            onChange={(v) => set("verify", v)}
          />
        </Row>
        <Row label="Judge" desc="Deduplicate across reviewers and recalibrate severity.">
          <TriSwitch
            label="Judge findings"
            value={settings.judge}
            fallback={true}
            onChange={(v) => set("judge", v)}
          />
        </Row>
        <Row
          label="Propose fixes"
          desc="Suggest an edit for a finding that a small change in one place fixes. A suggestion is kept only if it applies and the file still parses. Adds model calls."
        >
          <TriSwitch
            label="Propose fixes"
            value={settings.fixes}
            fallback={false}
            onChange={(v) => set("fixes", v)}
          />
        </Row>
      </div>

      <div className="section card">
        <div className="card-head">
          <h2>Context</h2>
          <span className="subtle small">What reviewers read besides the change.</span>
        </div>
        <Row
          label="Linked tasks"
          desc="The issues a pull request closes, and Jira or TAPD tasks it names, so reviewers can check it does what was asked."
        >
          <TriSwitch
            label="Give reviewers linked tasks"
            value={settings.linkedTasks}
            fallback={true}
            onChange={(v) => set("linkedTasks", v)}
          />
        </Row>
      </div>

      <div className="section card">
        <div className="card-head">
          <h2>Files</h2>
          <span className="subtle small">Globs, matched against paths in the change.</span>
        </div>
        <Row label="Only these files" desc="When set, files outside these globs are not reviewed.">
          <GlobList
            label="Include glob"
            value={settings.include ?? []}
            placeholder="src/**"
            onChange={(v) => set("include", v)}
          />
        </Row>
        <Row
          label="Never these files"
          desc="Lockfiles, generated and vendored code are already excluded."
        >
          <GlobList
            label="Exclude glob"
            value={settings.exclude ?? []}
            placeholder="vendor/**"
            onChange={(v) => set("exclude", v)}
          />
        </Row>
      </div>

      <div className="section card">
        <div className="card-head">
          <h2>Sampling</h2>
          <span className="subtle small">Not sent to a call that asks for reasoning effort.</span>
        </div>
        <Row label="Temperature" desc="0–2; unset uses each provider's default.">
          <NumberField
            label="Temperature"
            value={sampling.temperature}
            placeholder="provider default"
            min={0}
            max={2}
            onChange={(v) => set("sampling", withOptional(sampling, "temperature", v))}
          />
        </Row>
        <Row label="Seed" desc="Makes runs repeatable where the provider supports it.">
          <NumberField
            label="Seed"
            value={sampling.seed}
            placeholder="none"
            min={0}
            max={2 ** 31 - 1}
            onChange={(v) => set("sampling", withOptional(sampling, "seed", v && Math.round(v)))}
          />
        </Row>
      </div>
    </>
  );
}
