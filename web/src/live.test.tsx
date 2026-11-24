import fixture from "@open-cr-agent/cloud-contract/fixtures/events.json" with { type: "json" };
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEventView, LiveRunView, LiveShareView } from "../../src/shared/index.js";
import { emptyProgress, fold, shownFindings } from "./live/fold.js";
import { LivePage } from "./pages/LivePage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

const events = fixture.events
  .slice(0, -1)
  .map(({ version: _v, runId: _r, ...e }) => e) as unknown as LiveEventView[];

describe("folding a run's events", () => {
  it("keeps the newest version of each finding and how the run ended", () => {
    const p = fold(emptyProgress(), events);
    expect(p.seq).toBe(events.length);
    expect(p.target).toBe(fixture.events[0]?.data.target);
    const stages = fixture.events
      .filter((e) => e.kind === "stage")
      .map((e) => (e.data as { stage: string }).stage);
    expect(p.stages).toEqual(stages);
    expect([...p.findings.values()].every((f) => !f.dropped)).toBe(true);
    expect(p.ending?.kind).toBe("finished");
    expect(p.tasks.size).toBe(1);
    expect(p.stageAt).toBe(fixture.events.findLast((e) => e.kind === "stage")?.at);
  });

  it("changes nothing for events it already has, in any order", () => {
    const once = fold(emptyProgress(), events);
    expect(fold(once, events.slice(3, 8))).toBe(once);
    const shuffled = fold(fold(emptyProgress(), events.slice(8)), events.slice(0, 8));
    expect(shuffled.seq).toBe(events.length);
  });
});

describe("the findings a run shows", () => {
  // Up to the first finding the verifier settled; another is still unchecked.
  const midRun = events.slice(
    0,
    events.findIndex((e) => e.kind === "finding" && e.data.settled) + 1,
  );

  it("are the settled ones while it runs, the others counted", () => {
    const { shown, checking } = shownFindings(fold(emptyProgress(), midRun), false);
    expect(shown.map((f) => f.settled)).toEqual([true]);
    expect(checking).toBe(1);
  });

  it("never include one that is later taken out", () => {
    const final = new Set(fold(emptyProgress(), events).findings.keys());
    for (let n = 1; n <= events.length; n += 1) {
      const { shown } = shownFindings(fold(emptyProgress(), events.slice(0, n)), false);
      expect(shown.filter((f) => !final.has(f.id))).toEqual([]);
    }
  });

  it("are all of them once it ended, settled or from an engine that settles nothing", () => {
    const raw = midRun.filter((e) => !(e.kind === "finding" && e.data.settled));
    const { shown, checking } = shownFindings(fold(emptyProgress(), raw), true);
    expect(shown).toHaveLength(2);
    expect(checking).toBe(0);
  });
});

class FakeSource {
  static last: FakeSource | undefined;
  readonly listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(kind: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), fn]);
  }
  emit(kind: string, data: unknown) {
    const e = new MessageEvent(kind, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    for (const fn of this.listeners.get(kind) ?? []) fn(e);
  }
  close() {
    this.closed = true;
  }
}

const run: LiveRunView = {
  id: "lr1",
  runId: "run-2026-11-21-c3d4",
  owner: "octo",
  access: "owner",
  target: "pull request #7",
  title: null,
  source: "github",
  repo: "octo/web",
  prNumber: 7,
  state: "running",
  verdict: null,
  costUsd: 0,
  createdAt: "2026-11-22T10:00:00.000Z",
  updatedAt: "2026-11-22T10:00:00.000Z",
};
const share: LiveShareView = { link: null, people: [] };

function serve(view: Partial<LiveRunView> = {}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET")
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith("/api/live/lr1/comments") && method === "POST")
        return Response.json(
          {
            id: "c1",
            author: "octo",
            findingId: null,
            body: "Looking",
            createdAt: new Date().toISOString(),
            removable: true,
          },
          { status: 201 },
        );
      if (url.startsWith("/api/live/lr1/comments")) return Response.json({ comments: [] });
      if (url.startsWith("/api/live/lr1/link"))
        return Response.json({
          link: { role: "watch", url: "https://ocra.test/live/lr1?k=abc" },
          people: [],
        });
      if (url.startsWith("/api/live/lr1"))
        return view.access && view.access !== "owner"
          ? Response.json({ run: { ...run, ...view } })
          : Response.json({ run: { ...run, ...view }, share });
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return sent;
}

describe("the live page", () => {
  it("shows a finding once it is settled, the rest when the run ends, and stops listening", async () => {
    serve();
    render(<LivePage id="lr1" />);
    await screen.findByText("No confirmed findings yet");
    expect(FakeSource.last?.url).toBe("/api/live/lr1/stream");
    const source = FakeSource.last as FakeSource;
    const findings = events.filter((e) => e.kind === "finding").map((e) => e.data);
    const settledAt = events.findIndex((e) => e.kind === "finding" && e.data.settled);
    const settled = findings.find((f) => f.settled);
    const unchecked = findings.find((f) => f.id !== settled?.id);

    act(() => {
      for (const e of events.slice(0, settledAt)) source.emit("review", e);
    });
    expect(await screen.findByText("2 being checked")).toBeTruthy();
    expect(screen.queryByText(settled?.title ?? "")).toBeNull();

    act(() => source.emit("review", events[settledAt]));
    expect(await screen.findByText(settled?.title ?? "")).toBeTruthy();
    const file = settled?.file ?? "";
    expect(screen.getByTitle(file).textContent).toContain(file);
    expect(screen.getByText("1 confirmed so far · 1 more being checked")).toBeTruthy();
    expect(screen.queryByText(unchecked?.title ?? "")).toBeNull();

    act(() => {
      for (const e of events.slice(settledAt + 1)) source.emit("review", e);
    });
    expect(await screen.findByText("1 finding")).toBeTruthy();
    expect(screen.getByText(settled?.title ?? "")).toBeTruthy();
    act(() => source.emit("end", "finished"));
    expect(source.closed).toBe(true);
  });

  it("lists each task while it runs and how it ended", async () => {
    serve();
    render(<LivePage id="lr1" />);
    await screen.findByText("No confirmed findings yet");
    const source = FakeSource.last as FakeSource;
    const until = (kind: string) => events.findIndex((e) => e.kind === kind) + 1;
    act(() => {
      for (const e of events.slice(0, until("task.started"))) source.emit("review", e);
    });
    const task = within(await screen.findByRole("list", { name: "Tasks" })).getByRole("listitem");
    expect(task.textContent).toBe("security2 filesRunning");
    expect(within(screen.getByRole("region", { name: "Stages" })).getByText(/\ds$/)).toBeTruthy();
    act(() => {
      for (const e of events.slice(0, until("task.finished"))) source.emit("review", e);
    });
    await waitFor(() => expect(task.textContent).toBe("security2 filesCompleted"));
    expect(task.querySelector(".task-mark.is-done")).toBeTruthy();
  });

  it("lets the owner turn the link on and comment, and a watcher only watch", async () => {
    const sent = serve();
    render(<LivePage id="lr1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Share/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Share by link" }));
    await screen.findByDisplayValue("https://ocra.test/live/lr1?k=abc");
    expect(sent.at(-1)).toMatchObject({ method: "PUT", body: { role: "watch" } });

    fireEvent.change(screen.getByLabelText("Comment on this run"), {
      target: { value: "Looking" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(screen.getByText("Looking")).toBeTruthy());

    cleanup();
    serve({ access: "watch", owner: "mona" });
    history.replaceState(null, "", "/live/lr1?k=abc");
    render(<LivePage id="lr1" />);
    await screen.findByText("mona");
    expect(FakeSource.last?.url).toBe("/api/live/lr1/stream?k=abc");
    expect(screen.queryByRole("button", { name: /Share/ })).toBeNull();
    expect(screen.queryByLabelText("Comment on this run")).toBeNull();
  });

  it("heads the run with its pull request's title when the server knows it", async () => {
    serve({ title: "Retry the upload" });
    render(<LivePage id="lr1" />);
    await screen.findByText("No confirmed findings yet");
    act(() => {
      for (const e of events) (FakeSource.last as FakeSource).emit("review", e);
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Retry the upload");
  });

  it("says when a run is not shared with the viewer", async () => {
    serve();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "not_found" }, { status: 404 })),
    );
    render(<LivePage id="lr1" />);
    expect(await screen.findByText("This run isn't shared with you")).toBeTruthy();
  });
});
