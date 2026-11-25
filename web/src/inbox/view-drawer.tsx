import { type ReactNode, type SubmitEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullFilters, PullRole } from "../../../src/shared/index.js";
import { why } from "../api.js";
import { CopyButton } from "../copy-button.js";
import { Drawer } from "../drawer.js";
import { shareLink, type ViewDraft } from "./views.js";

type Choice<T extends string> = { value: T; label: string };
type ListKey = "roles" | "states" | "checks" | "reviews" | "verdicts" | "repos";

const ROLES: Choice<PullRole>[] = [
  { value: "reviewer", label: "Asks my review" },
  { value: "author", label: "Mine" },
  { value: "assignee", label: "Assigned to me" },
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
const REVIEWS: Choice<"approved" | "changes_requested" | "required" | "none">[] = [
  { value: "required", label: "Review required" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "none", label: "No decision yet" },
];
const VERDICTS: Choice<"blocking" | "not_blocking" | "unreviewed">[] = [
  { value: "blocking", label: "Blocking" },
  { value: "not_blocking", label: "Not blocking" },
  { value: "unreviewed", label: "Not reviewed yet" },
];
const WITHIN_DAYS = [1, 7, 30];

const listed = (text: string) => {
  const list = text
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
};

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
  const [labels, setLabels] = useState((props.initial.filters.labels ?? []).join(", "));
  const [error, setError] = useState<unknown>(null);

  const draft = (): ViewDraft => {
    return {
      name: name.trim(),
      filters: { ...filters, authors: listed(authors), labels: listed(labels) },
    };
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
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    void run(() => props.onSave(draft()));
  };

  // A view made elsewhere may hold a span the list does not offer: it stays choosable.
  const within = props.initial.filters.updatedWithinDays;
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
    <Drawer
      title="Section"
      heading={props.editing ? "Edit section" : "New section"}
      onClose={onClose}
      onSubmit={submit}
      foot={
        <>
          {props.onDelete && (
            <Button
              type="button"
              variant="destructive-outline"
              onClick={() => props.onDelete && void run(props.onDelete)}
            >
              Delete
            </Button>
          )}
          <CopyButton text={() => shareLink(draft())} label="Copy link" said="Link copied" />
          <Button type="submit">Save</Button>
        </>
      }
    >
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
      <Group legend="Opened by">
        <select
          className="input"
          aria-label="Opened by"
          value={filters.authoredBy ?? ""}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              authoredBy: (e.target.value || undefined) as PullFilters["authoredBy"],
            }))
          }
        >
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="others">Someone else</option>
        </select>
      </Group>
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
      <Group legend="ocra's review">{checks("verdicts", VERDICTS)}</Group>
      <Group legend="Updated">
        <select
          className="input"
          aria-label="Updated"
          value={filters.updatedWithinDays ?? ""}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              updatedWithinDays: e.target.value ? Number(e.target.value) : undefined,
            }))
          }
        >
          <option value="">Any time</option>
          {[...new Set([...WITHIN_DAYS, ...(within ? [within] : [])])]
            .sort((a, b) => a - b)
            .map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "In the last day" : `In the last ${days} days`}
              </option>
            ))}
        </select>
      </Group>
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
      <label className="field">
        Labels
        <input
          className="input"
          placeholder="Any of these, separated by commas"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />
      </label>
      {error ? (
        <p className="error" role="alert">
          Could not save it: {why(error)}.
        </p>
      ) : null}
    </Drawer>
  );
}
