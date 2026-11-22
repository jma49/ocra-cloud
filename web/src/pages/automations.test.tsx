import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api.js";
import { Automations } from "./Automations.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = (autoReview: boolean): Me => ({
  login: "ada",
  githubId: 1,
  session: "web",
  since: "",
  codeGraphs: "off",
  autoReview,
  platforms: ["github", "gitlab"],
});
const rule = {
  id: "r1",
  name: "Payments need two eyes",
  enabled: true,
  trigger: "queued",
  conditions: { repoIds: ["p1"], baseBranches: ["main"] },
  actions: [{ kind: "request_reviewers", reviewers: ["octocat"] }],
  runsHere: false,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
};
const run = {
  id: "u1",
  ruleId: "r1",
  ruleName: "Payments need two eyes",
  trigger: "queued",
  pull: "acme/payments#482",
  outcome: "partial",
  actions: [{ kind: "request_reviewers", outcome: "needs_self_hosted" }],
  createdAt: "2026-11-22T10:00:00Z",
};

type Sent = { url: string; method: string; body: unknown };
function serve(rules: unknown[]) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === "/api/automations/dry-run")
          return Response.json({
            matches: [{ ruleId: "r1", name: rule.name, actions: ["request_reviewers"] }],
            skipped: [{ ruleId: "r2", name: "Huge changes", reason: "too_many_files" }],
          });
        return Response.json({ rule });
      }
      if (url === "/api/automations/rules") return Response.json({ rules });
      if (url === "/api/automations/runs") return Response.json({ runs: [run] });
      if (url === "/api/auto-review/repos")
        return Response.json({ repos: [{ id: "p1", fullName: "acme/payments" }] });
      return Response.json({ channels: [{ id: "n1", name: "#payments" }] });
    }),
  );
  return sent;
}

describe("the Automations page", () => {
  it("says what each rule does, that bot actions need a self-hosted server, and how runs went", async () => {
    const sent = serve([rule]);
    render(<Automations me={me(true)} />);
    expect(
      await screen.findByText("When queued, in acme/payments, into main: ask octocat"),
    ).toBeTruthy();
    expect(screen.getByText(/only a self-hosted server has/)).toBeTruthy();
    expect(screen.getByText("acme/payments#482")).toBeTruthy();
    expect(screen.getByText("Needs a self-hosted server")).toBeTruthy();
    await act(
      async () => void fireEvent.click(screen.getByRole("switch", { name: `${rule.name} on` })),
    );
    expect(sent[0]).toMatchObject({
      url: "/api/automations/rules/r1",
      method: "PUT",
      body: { enabled: false, trigger: "queued", actions: rule.actions },
    });
  });

  it("opens a new rule from the empty list", async () => {
    serve([]);
    render(<Automations me={me(true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Write your first rule" }));
    expect(screen.getByRole("form", { name: "New rule" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write your first rule" })).toBeNull();
  });

  it("offers only what a rule on an uploaded review may test and do, where nothing is queued", async () => {
    const sent = serve([]);
    render(<Automations me={me(false)} />);
    await screen.findByText("No rules yet");
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const form = screen.getByRole("form", { name: "New rule" });
    expect(within(form).queryByLabelText("Authors")).toBeNull();
    expect(within(form).queryByRole("option", { name: "Skip the review" })).toBeNull();
    fireEvent.change(within(form).getByLabelText("Rule name"), { target: { value: "Critical" } });
    fireEvent.change(within(form).getByLabelText("Critical finding"), {
      target: { value: "yes" },
    });
    fireEvent.change(within(form).getByLabelText("Changed files to match"), {
      target: { value: "db/**, *.sql" },
    });
    fireEvent.change(within(form).getByLabelText("Changed files to leave out"), {
      target: { value: "db/seeds/**" },
    });
    fireEvent.click(within(form).getByLabelText(/Every changed file must match/));
    fireEvent.change(within(form).getByLabelText("Notify a channel, action 1"), {
      target: { value: "n1" },
    });
    await act(
      async () => void fireEvent.click(within(form).getByRole("button", { name: "Add rule" })),
    );
    expect(sent[0]).toEqual({
      url: "/api/automations/rules",
      method: "POST",
      body: {
        name: "Critical",
        enabled: true,
        trigger: "reviewed",
        conditions: {
          critical: true,
          paths: { include: ["db/**", "*.sql"], exclude: ["db/seeds/**"], every: true },
        },
        actions: [{ kind: "notify", channelId: "n1" }],
      },
    });
  });

  it("drops an action the new trigger cannot take, and tries the rules on a described pull request", async () => {
    const sent = serve([rule]);
    render(<Automations me={me(true)} />);
    await screen.findByRole("switch", { name: `${rule.name} on` });
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const form = screen.getByRole("form", { name: "New rule" });
    fireEvent.change(within(form).getByLabelText("Action 1"), { target: { value: "skip_review" } });
    expect(within(form).getByText("The head is not reviewed.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Reviewed" }));
    expect(within(form).queryByText("The head is not reviewed.")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    const tryIt = screen.getByRole("form", { name: "Try the rules" });
    fireEvent.change(within(tryIt).getByLabelText("Base branch"), { target: { value: "main" } });
    fireEvent.change(within(tryIt).getByLabelText("Changed files"), {
      target: { value: "db/001.sql, src/refund.ts" },
    });
    await act(async () => void fireEvent.click(within(tryIt).getByRole("button", { name: "Try" })));
    expect(sent[0]).toEqual({
      url: "/api/automations/dry-run",
      method: "POST",
      body: {
        trigger: "queued",
        pull: { baseBranch: "main", paths: ["db/001.sql", "src/refund.ts"] },
      },
    });
    await waitFor(() => expect(within(tryIt).getByText("would request reviewers")).toBeTruthy());
    expect(within(tryIt).getByText("not decided: too many changed files to decide")).toBeTruthy();
  });
});
