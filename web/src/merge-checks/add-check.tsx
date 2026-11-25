import { type SubmitEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MERGE_CHECK_KINDS,
  type MergeCheckKind,
  type MergeCheckSettings,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { listOf } from "../form.js";
import { useAction } from "../ui.js";
import { KIND_HINT, KIND_LABEL } from "./describe.js";

// A new check for an enrolled repository: its kind, whether it warns or
// blocks, and the few settings that kind takes.

const num = (s: string) => (s.trim() ? Number(s) : undefined);

export function AddCheck(props: { repoId: string; onAdded: () => void }) {
  const [kind, setKind] = useState<MergeCheckKind>("linked_issue");
  const [mode, setMode] = useState<"warn" | "block">("block");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [open, setOpen] = useState(false);

  const settings = (): MergeCheckSettings[MergeCheckKind] => {
    switch (kind) {
      case "linked_issue":
        return { open: open || undefined, label: a.trim() || undefined };
      case "title":
        return { prefixes: listOf(a), glob: b.trim() || undefined };
      case "description":
        return { headings: listOf(a) };
      case "size":
        return { maxFiles: num(a), maxLines: num(b) };
      case "critical_findings":
        return {};
      case "instruction":
        return { text: a.trim() };
    }
  };
  const add = useAction(() =>
    api(`/merge-checks/repos/${props.repoId}/checks`, {
      method: "POST",
      body: JSON.stringify({ kind, mode, settings: settings() }),
    }),
  );
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if ((await add.run()) === undefined) return;
    setA("");
    setB("");
    setOpen(false);
    props.onAdded();
  };
  const pick = (k: MergeCheckKind) => {
    setKind(k);
    setA("");
    setB("");
  };
  const ready =
    kind === "title"
      ? a.trim() !== "" || b.trim() !== ""
      : kind === "size"
        ? a.trim() !== "" || b.trim() !== ""
        : kind === "instruction"
          ? a.trim() !== ""
          : true;

  return (
    <form className="stack add-check" onSubmit={submit} aria-label="Add a check">
      <div className="add-fields">
        <select
          className="input"
          aria-label="Check"
          value={kind}
          onChange={(e) => pick(e.target.value as MergeCheckKind)}
        >
          {MERGE_CHECK_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as "warn" | "block")}
        >
          <option value="block">Blocks the merge</option>
          <option value="warn">Warns only</option>
        </select>
        {kind === "linked_issue" && (
          <>
            <input
              className="input"
              aria-label="Label it must have"
              placeholder="Label it must have (optional)"
              maxLength={50}
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            <label className="check small">
              <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
              Still open
            </label>
          </>
        )}
        {kind === "title" && (
          <>
            <input
              className="input mono"
              aria-label="Prefixes"
              placeholder="feat:, fix:, docs:"
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            <input
              className="input mono"
              aria-label="Or a pattern"
              placeholder="or a pattern, e.g. [*] *"
              maxLength={100}
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
          </>
        )}
        {kind === "description" && (
          <input
            className="input grow"
            aria-label="Required headings"
            placeholder="Required headings, e.g. Why, How tested (optional)"
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
        )}
        {kind === "size" && (
          <>
            <input
              className="input"
              type="number"
              min={1}
              aria-label="At most files"
              placeholder="At most files"
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            <input
              className="input"
              type="number"
              min={1}
              aria-label="At most lines"
              placeholder="At most lines"
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
          </>
        )}
        {kind === "instruction" && (
          <input
            className="input grow"
            aria-label="Instruction"
            placeholder="e.g. A migration comes with its rollback"
            maxLength={500}
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
        )}
        <Button type="submit" size="sm" disabled={add.busy || !ready}>
          Add
        </Button>
      </div>
      <span className="subtle small">{KIND_HINT[kind]}</span>
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {why(add.error)}.
        </p>
      )}
    </form>
  );
}
