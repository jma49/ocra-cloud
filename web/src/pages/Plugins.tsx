import Puzzle from "lucide-react/icons/puzzle";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSettings } from "../prefs.js";
import { Link } from "../router.js";
import { EmptyState, PageHead } from "../ui.js";

// Plugins run code, so the account only names them (ADR-0027): each machine
// installs and allows a pinned version itself, and only then loads it.

const PACKAGE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function Plugins() {
  const { settings, set, setMany } = useSettings();
  const plugins = settings.plugins ?? [];
  const pluginSettings = settings.pluginSettings ?? {};
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const valid = PACKAGE.test(name.trim()) && !plugins.includes(name.trim());

  const add = () => {
    if (!valid) return;
    set("plugins", [...plugins, name.trim()]);
    setName("");
  };
  // One update for both keys: two separate ones would each start from the
  // same draft and the second would undo the first.
  const remove = (p: string) => {
    const { [p]: _, ...rest } = pluginSettings;
    setMany({ plugins: plugins.filter((x) => x !== p), pluginSettings: rest });
  };
  const saveSettings = (p: string) => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : undefined;
      if (parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed)))
        throw new Error();
      const { [p]: _, ...rest } = pluginSettings;
      setMany({ pluginSettings: parsed ? { ...rest, [p]: parsed } : rest });
      setEditing(null);
      setError("");
    } catch {
      setError("Settings must be a JSON object.");
    }
  };

  return (
    <>
      <PageHead
        title="Plugins"
        sub="Reviewers, rule packs and runtimes from npm, with their settings."
      />
      <div className="note lead-note">
        <span>
          <b>Plugins run code on your machine.</b> ocra Cloud only names them: each machine installs
          a pinned version itself, and ocra loads a plugin listed here only after you allow it there
          with <span className="mono">ocra plugins allow &lt;name&gt;@&lt;version&gt;</span>. A
          listed plugin a machine has not allowed is skipped with a warning. Plugins never load when
          reviewing a pull request's own files.
        </span>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Your plugins</h3>
          <span className="subtle small">{plugins.length} of 20</span>
        </div>
        {plugins.length === 0 && (
          <EmptyState icon={Puzzle} title="No plugins yet">
            Name an npm package below to add its reviewers, rules or runtime. The built-in reviewers
            are under <Link to="/agents">Agents & models</Link>.
          </EmptyState>
        )}
        {plugins.map((p) => (
          <div key={p}>
            <div className="list-row">
              <div className="grow">
                <div className="mono strong">{p}</div>
                <div className="subtle small">
                  {pluginSettings[p] ? "Has settings" : "No settings"} · allow on each machine:{" "}
                  <span className="mono">ocra plugins allow {p}@&lt;version&gt;</span>
                </div>
              </div>
              <div className="row-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(editing === p ? null : p);
                    setText(pluginSettings[p] ? JSON.stringify(pluginSettings[p], null, 2) : "");
                    setError("");
                  }}
                >
                  Settings
                </Button>
                <Button
                  type="button"
                  variant="destructive-outline"
                  size="sm"
                  onClick={() => remove(p)}
                >
                  Remove
                </Button>
              </div>
            </div>
            {editing === p && (
              <div className="inline-form plugin-settings">
                <textarea
                  className="input mono"
                  rows={6}
                  aria-label={`${p} settings`}
                  placeholder='{ "strict": true }'
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="row-gap center">
                  <Button type="button" size="sm" onClick={() => saveSettings(p)}>
                    Apply
                  </Button>
                  <span className="subtle small">
                    Applied to the draft; save the page to keep it.
                  </span>
                  {error && <span className="error">{error}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
        <form
          className="list-row"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className="input mono grow"
            aria-label="Plugin package name"
            placeholder="@acme/ocra-rules"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!valid || plugins.length >= 20}
          >
            Add plugin
          </Button>
        </form>
      </div>
    </>
  );
}
