import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullFilters } from "../../../src/shared/index.js";
import { why } from "../api.js";
import { CloseGlyph } from "../glyphs.js";
import { shareLink, type ViewDraft } from "./views.js";

type Choice<T extends string> = { value: T; label: string };
type ListKey = "roles" | "states" | "checks" | "reviews" | "repos";

const ROLES: Choice<"reviewer" | "author">[] = [
  { value: "reviewer", label: "Asks my review" },
  { value: "author", label: "Mine" },
];
const STATES: Choice<"open" | "merged">[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged this week" },
];
const CHECKS: Choice<"passing" | "failing" | "pending">[] = [
  { value: "failing", label: "Failing" },
  { value: "pending", label: "Running" },
  { value: "passing", label: "Passing" },
];
const REVIEWS: Choice<"approved" | "changes_requested" | "required">[] = [
  { value: "required", label: "Review required" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
];

function toggled(list: string[] | undefined, value: string): string[] | undefined {
  const next = list?.includes(value) ? list.filter((v) => v !== value) : [...(list ?? []), value];
  return next.length > 0 ? next : undefined;
}

function Group(props: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="view-group">
      <legend>{props.legend}</legend>
      {props.children}
    </fieldset>
  );
}

export function ViewDrawer(props: {
  initial: ViewDraft;
  repos: string[];
  editing: boolean;
  onSave: (draft: ViewDraft) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { onClose } = props;
  const [name, setName] = useState(props.initial.name);
  const [filters, setFilters] = useState<PullFilters>(props.initial.filters);
  const [authors, setAuthors] = useState((props.initial.filters.authors ?? []).join(", "));
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const draft = (): ViewDraft => {
    const list = authors
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    return { name: name.trim(), filters: { ...filters, authors: list.length ? list : undefined } };
  };
  const run = async (act: () => Promise<unknown>) => {
    setError(null);
    try {
      await act();
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => props.onSave(draft()));
  };
  const share = async () => {
    await navigator.clipboard?.writeText(shareLink(draft())).catch(() => {});
    setCopied(true);
  };

  const checks = <T extends string>(key: ListKey, choices: Choice<T>[]) =>
    choices.map((c) => (
      <label key={c.value}>
        <input
          type="checkbox"
          checked={(filters[key] as string[] | undefined)?.includes(c.value) ?? false}
          onChange={() =>
            setFilters((f) => ({ ...f, [key]: toggled(f[key] as string[], c.value) }))
          }
        />{" "}
        {c.label}
      </label>
    ));

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Section">
        <form className="view-form" onSubmit={submit}>
          <div className="drawer-head">
            <h2>{props.editing ? "Edit section" : "New section"}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <CloseGlyph />
            </button>
          </div>
          <div className="drawer-body">
            <label className="field">
              Name
              <input
                className="input"
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <p className="muted small">
              A pull shows here when it matches every group you set; within a group, any choice.
            </p>
            <Group legend="Who">{checks("roles", ROLES)}</Group>
            <Group legend="State">{checks("states", STATES)}</Group>
            <Group legend="Drafts">
              <select
                className="input"
                value={filters.drafts ?? "include"}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, drafts: e.target.value as PullFilters["drafts"] }))
                }
              >
                <option value="include">Include drafts</option>
                <option value="exclude">Leave out drafts</option>
                <option value="only">Only drafts</option>
              </select>
            </Group>
            <Group legend="Checks">{checks("checks", CHECKS)}</Group>
            <Group legend="Review">{checks("reviews", REVIEWS)}</Group>
            {props.repos.length > 0 && (
              <Group legend="Repositories">
                {checks(
                  "repos",
                  props.repos.map((r) => ({ value: r, label: r })),
                )}
              </Group>
            )}
            <label className="field">
              Authors
              <input
                className="input"
                placeholder="Logins, separated by commas"
                value={authors}
                onChange={(e) => setAuthors(e.target.value)}
              />
            </label>
            {error ? (
              <p className="error" role="alert">
                Could not save it: {why(error)}.
              </p>
            ) : null}
          </div>
          <div className="drawer-foot">
            {props.onDelete && (
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => props.onDelete && void run(props.onDelete)}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={share}>
              {copied ? "Link copied" : "Copy link"}
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </aside>
    </>
  );
}
