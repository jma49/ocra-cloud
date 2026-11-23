import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationRuleView, AutomationRunView } from "../../../src/shared/index.js";
import { RuleForm } from "./rule-form.js";
import { Runs } from "./runs.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve() {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).actions);
      return Response.json({ rule: {} });
    }),
  );
  return sent;
}

const form = (rule?: AutomationRuleView) => {
  render(<RuleForm rule={rule} queued repos={null} channels={[]} done={() => {}} />);
  return within(screen.getByRole("form"));
};
const add = (f: ReturnType<typeof form>, login: string) => {
  const input = f.getByLabelText("People to choose from, action 1");
  fireEvent.change(input, { target: { value: login } });
  fireEvent.keyDown(input, { key: "Enter" });
};
const save = (f: ReturnType<typeof form>, name: string) =>
  act(async () => void fireEvent.click(f.getByRole("button", { name })));

describe("an Assign reviewers action", () => {
  it("asks one suggested reviewer until told otherwise, and needs people for a strategy that chooses from them", async () => {
    const sent = serve();
    const f = form();
    fireEvent.change(f.getByLabelText("Rule name"), { target: { value: "Spread reviews" } });
    fireEvent.change(f.getByLabelText("Action 1"), { target: { value: "assign_reviewers" } });
    expect(f.queryByLabelText("People to choose from, action 1")).toBeNull();
    await save(f, "Add rule");
    expect(sent[0]).toEqual([{ kind: "assign_reviewers", strategy: "suggested", count: 1 }]);

    fireEvent.click(f.getByRole("button", { name: "In turn" }));
    expect(f.getByText("Add at least one person.")).toBeTruthy();
    expect(f.getByRole("button", { name: "Add rule" }).hasAttribute("disabled")).toBe(true);
    add(f, "ada");
    add(f, "grace");
    fireEvent.click(f.getByRole("button", { name: "2" }));
    fireEvent.click(f.getByLabelText("Code owners first, action 1"));
    await save(f, "Add rule");
    expect(sent[1]).toEqual([
      {
        kind: "assign_reviewers",
        strategy: "round_robin",
        count: 2,
        logins: ["ada", "grace"],
        codeOwnersFirst: true,
      },
    ]);

    fireEvent.click(f.getByRole("button", { name: "Suggested" }));
    await save(f, "Add rule");
    expect(sent[2]).toEqual([
      { kind: "assign_reviewers", strategy: "suggested", count: 2, codeOwnersFirst: true },
    ]);
  });

  it("opens a saved assignment as it was saved, and lets a person be taken out", async () => {
    const sent = serve();
    const f = form({
      id: "r1",
      name: "Share the load",
      enabled: true,
      trigger: "queued",
      conditions: {},
      actions: [
        { kind: "assign_reviewers", strategy: "least_loaded", count: 3, logins: ["ada", "grace"] },
      ],
      runsHere: true,
      createdAt: "2026-11-20T10:00:00Z",
      updatedAt: "2026-11-20T10:00:00Z",
    });
    expect(f.getByRole("button", { name: "Least loaded" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(f.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(f.getByRole("button", { name: "Remove ada" }));
    await save(f, "Save rule");
    expect(sent[0]).toEqual([
      { kind: "assign_reviewers", strategy: "least_loaded", count: 3, logins: ["grace"] },
    ]);
  });
});

describe("an assignment's run", () => {
  const run = (outcome: AutomationRunView["actions"][number]["outcome"]): AutomationRunView => ({
    id: outcome,
    ruleId: "r1",
    ruleName: "Share the load",
    trigger: "queued",
    pull: "acme/payments#482",
    outcome: "done",
    actions: [{ kind: "assign_reviewers", outcome }],
    reason: null,
    attempts: 1,
    retryAt: null,
    createdAt: "2026-11-22T10:00:00Z",
  });

  it("warns when no one was left to ask, and stays calm when nothing was needed", () => {
    render(<Runs runs={[run("no_candidates"), run("enough_reviewers"), run("refused")]} />);
    expect(screen.getByText("No one to assign").className).toBe("warn-inline");
    expect(screen.getByText("Enough reviewers already").className).toBe("muted");
    expect(screen.getByText("Refused").className).toBe("error-inline");
  });
});
