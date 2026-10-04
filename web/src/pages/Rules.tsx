import { useRef, useState } from "react";
import { type Rule, useSettings } from "../prefs.js";
import { PageHead } from "../ui.js";

// Path-scoped instructions for the reviewers (ADR-0027). They apply
// alongside a repository's .ocra/rules.json and AGENTS.md, never instead.

const MAX = 50;
const paths = (r: Rule) => (Array.isArray(r.path) ? r.path : [r.path]);

export function Rules() {
  const { settings, set } = useSettings();
  const rules = settings.rules ?? [];
  const [editing, setEditing] = useState<number | null>(null);
  // Rules have no id of their own; these keep each row's identity while the
  // list is edited, and are never sent.
  const ids = useRef<string[]>([]);
  while (ids.current.length < rules.length) ids.current.push(crypto.randomUUID());
  const removeAt = (i: number) => {
    ids.current.splice(i, 1);
    set(
      "rules",
      rules.filter((_, j) => j !== i),
    );
    setEditing(null);
  };
  const update = (i: number, r: Rule) =>
    set(
      "rules",
      rules.map((x, j) => (j === i ? r : x)),
    );
  return (
    <>
      <PageHead
        title="Rules"
        sub="Tell reviewers what your code must do, by path. They apply alongside a repository's own rules and AGENTS.md."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={rules.length >= MAX}
            onClick={() => {
              set("rules", [...rules, { path: "**", rule: "" }]);
              setEditing(rules.length);
            }}
          >
            + Add rule
          </button>
        }
      />
      {rules.length === 0 ? (
        <div className="card empty-hero">
          <h3>No rules yet</h3>
          <p>
            A rule is a sentence the reviewers check every matching file against, such as "Every
            write to the billing service carries an idempotency key."
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              set("rules", [{ path: "**", rule: "" }]);
              setEditing(0);
            }}
          >
            Write your first rule
          </button>
        </div>
      ) : (
        <div className="card">
          {rules.map((r, i) => (
            <div className="list-row row-top" key={ids.current[i]}>
              <span className="step-n rule-n">{i + 1}</span>
              <div className="grow stack">
                {editing === i ? (
                  <>
                    <input
                      className="input mono"
                      aria-label="Paths"
                      placeholder="services/billing/**, **/*.sql"
                      value={paths(r).join(", ")}
                      onChange={(e) => {
                        const list = e.target.value
                          .split(",")
                          .map((p) => p.trim())
                          .filter(Boolean);
                        update(i, { ...r, path: list.length === 1 ? (list[0] as string) : list });
                      }}
                    />
                    <textarea
                      className="input"
                      rows={3}
                      maxLength={2000}
                      aria-label="Rule"
                      placeholder="What every matching file must do"
                      value={r.rule}
                      onChange={(e) => update(i, { ...r, rule: e.target.value })}
                      // biome-ignore lint/a11y/noAutofocus: the rule was just opened for writing
                      autoFocus
                    />
                    <div className="subtle small">{r.rule.length} / 2000</div>
                  </>
                ) : (
                  <>
                    <div className="chips">
                      {paths(r).map((p) => (
                        <span key={p} className="chip-x static">
                          {p}
                        </span>
                      ))}
                    </div>
                    <div>
                      {r.rule || <span className="subtle">Empty rule: it will not be saved</span>}
                    </div>
                  </>
                )}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setEditing(editing === i ? null : i)}
                >
                  {editing === i ? "Done" : "Edit"}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => removeAt(i)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="subtle small footnote">
        Up to {MAX} rules of 2,000 characters. A rule is shown to the reviewers as data, like a
        repository's; each report lists the rules it used and where they came from.
      </p>
    </>
  );
}
