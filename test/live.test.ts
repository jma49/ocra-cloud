import fixture from "@open-cr-agent/cloud-contract/fixtures/events.json" with { type: "json" };
import { beforeEach, describe, expect, it } from "vitest";
import { setSharing } from "../src/db/accounts.js";
import type {
  AuditPage,
  LiveCommentView,
  LiveRunView,
  LiveShareView,
} from "../src/shared/index.js";
import { auditLines, lines } from "./audit-lines.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

const events = fixture.events;
const run = {
  repoHash: "a".repeat(64),
  source: "github",
  pullRequest: { repository: "https://github.com/octo/web", number: 7 },
};
type Answer = { watch?: string };

async function owner(sharing = true) {
  const cli = await signInCli(1, "octo");
  await setSharing(db, cli.account.id, sharing);
  const web = await signIn(1, "octo");
  const relay = async (batch: readonly unknown[]) =>
    (
      await call("/api/live", { method: "POST", auth: cli.auth, json: { run, events: batch } })
    ).json() as Promise<Answer>;
  return { cli, web, relay };
}

const as = (auth: Record<string, string>) => (method: string, path: string, json?: unknown) =>
  call(path, {
    method,
    auth,
    headers: { origin: ORIGIN },
    ...(json === undefined ? {} : { json }),
  });

const idOf = (watch: string | undefined) => new URL(watch ?? "").pathname.split("/").at(-1) ?? "";

describe("relaying a run", () => {
  it("stores each event once, in order, and says where to watch it", async () => {
    const o = await owner();
    const first = await o.relay(events.slice(0, 5));
    expect(first.watch).toMatch(/^https:\/\/[^/]+\/live\/[\w-]+$/);
    // A resent batch and the rest; the newer kind at the end is skipped.
    await o.relay(events.slice(3, 10));
    await o.relay(events.slice(10));
    const id = idOf(first.watch);
    const get = as(o.web.auth);
    const stored = (await (await get("GET", `/api/live/${id}/events`)).json()) as {
      events: { seq: number; kind: string }[];
    };
    expect(stored.events.map((e) => e.seq)).toEqual(events.slice(0, -1).map((e) => e.seq));
    const after = (await (
      await get("GET", `/api/live/${id}/events?after=16`)
    ).json()) as typeof stored;
    expect(after.events.map((e) => e.kind)).toEqual(["warning", "finished"]);
    const view = (await (await get("GET", `/api/live/${id}`)).json()) as { run: LiveRunView };
    expect(view.run).toMatchObject({
      access: "owner",
      owner: "octo",
      state: "finished",
      verdict: "significant_concerns",
      repo: "octo/web",
      prNumber: 7,
    });
  });

  it("keeps nothing for an account that does not share findings", async () => {
    const o = await owner(false);
    expect(await o.relay(events.slice(0, 3))).toEqual({});
    const list = (await (await as(o.web.auth)("GET", "/api/live")).json()) as { runs: unknown[] };
    expect(list.runs).toEqual([]);
  });

  it("refuses an event of a known kind that does not fit, and the browser's session", async () => {
    const o = await owner();
    const broken = { ...events[4], data: { severity: "fatal" } };
    const res = await call("/api/live", {
      method: "POST",
      auth: o.cli.auth,
      json: { run, events: [broken] },
    });
    expect(res.status).toBe(400);
    const web = await call("/api/live", {
      method: "POST",
      auth: o.web.auth,
      json: { run, events },
    });
    expect(web.status).toBe(403);
  });

  it("ends a run once: a late batch does not reopen it", async () => {
    const o = await owner();
    const { watch } = await o.relay(events.slice(-2));
    await o.relay(events.slice(0, 3));
    const view = (await (await as(o.web.auth)("GET", `/api/live/${idOf(watch)}`)).json()) as {
      run: LiveRunView;
    };
    expect(view.run.state).toBe("finished");
  });
});

describe("sharing a run", () => {
  async function shared() {
    const o = await owner();
    const id = idOf((await o.relay(events.slice(0, 6))).watch);
    const guest = await signIn(2, "mona");
    return { o, id, owner: as(o.web.auth), guest: as(guest.auth) };
  }

  it("shows a run to nobody but its owner until it is shared", async () => {
    const { id, guest } = await shared();
    expect((await guest("GET", `/api/live/${id}`)).status).toBe(404);
    expect((await guest("GET", `/api/live/${id}/events`)).status).toBe(404);
    expect((await guest("GET", `/api/live/${id}/comments`)).status).toBe(404);
    expect((await guest("PUT", `/api/live/${id}/link`, { role: "comment" })).status).toBe(404);
    expect(
      (await guest("POST", `/api/live/${id}/people`, { login: "mona", role: "comment" })).status,
    ).toBe(404);
    expect((await guest("DELETE", `/api/live/${id}`)).status).toBe(404);
  });

  it("lets a person watch, then comment, until they are removed", async () => {
    const { id, owner: o, guest } = await shared();
    const added = (await (
      await o("POST", `/api/live/${id}/people`, { login: "mona", role: "watch" })
    ).json()) as LiveShareView;
    expect(added.people.map((p) => [p.login, p.role])).toEqual([["mona", "watch"]]);
    const seen = (await (await guest("GET", `/api/live/${id}`)).json()) as {
      run: LiveRunView;
      share?: unknown;
    };
    expect(seen.run).toMatchObject({ access: "watch", owner: "octo", repo: "octo/web" });
    expect(seen.share).toBeUndefined();
    const list = (await (await guest("GET", "/api/live")).json()) as { shared: LiveRunView[] };
    expect(list.shared.map((r) => r.id)).toEqual([id]);
    expect((await guest("POST", `/api/live/${id}/comments`, { body: "hi" })).status).toBe(403);

    await o("POST", `/api/live/${id}/people`, { login: "mona", role: "comment" });
    const posted = await guest("POST", `/api/live/${id}/comments`, {
      body: "Is this reachable?",
      findingId: "f1",
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ author: "mona", findingId: "f1", removable: true });

    const grant = added.people[0]?.id ?? "";
    await o("DELETE", `/api/live/${id}/people/${grant}`);
    await o("DELETE", `/api/live/${id}/people/${grant}`);
    expect((await guest("GET", `/api/live/${id}`)).status).toBe(404);
    const log = (await (await o("GET", "/api/audit")).json()) as AuditPage;
    expect(auditLines(log.events)).toEqual(
      lines(
        ["live.person_removed", { run: id }],
        ["live.person_added", { run: id, login: "mona", role: "comment" }],
        ["live.person_added", { run: id, login: "mona", role: "watch" }],
      ),
    );
  });

  it("opens to anyone signed in with the link, until it is replaced or turned off", async () => {
    const { id, owner: o, guest } = await shared();
    const on = (await (
      await o("PUT", `/api/live/${id}/link`, { role: "watch" })
    ).json()) as LiveShareView;
    const link = new URL(on.link?.url ?? "");
    expect(link.pathname).toBe(`/live/${id}`);
    const k = link.searchParams.get("k");
    expect((await guest("GET", `/api/live/${id}?k=${k}`)).status).toBe(200);
    expect((await guest("GET", `/api/live/${id}?k=${"0".repeat(64)}`)).status).toBe(404);
    expect((await call(`/api/live/${id}?k=${k}`)).status).toBe(401);

    // The owner can copy the same link again.
    const again = (await (await o("GET", `/api/live/${id}`)).json()) as { share: LiveShareView };
    expect(again.share.link?.url).toBe(on.link?.url);

    const widened = (await (
      await o("PUT", `/api/live/${id}/link`, { role: "comment" })
    ).json()) as LiveShareView;
    expect(widened.link).toEqual({ role: "comment", url: on.link?.url });
    const replaced = (await (
      await o("PUT", `/api/live/${id}/link`, { role: "comment", replace: true })
    ).json()) as LiveShareView;
    expect(replaced.link?.url).not.toBe(on.link?.url);
    expect((await guest("GET", `/api/live/${id}?k=${k}`)).status).toBe(404);
    await o("DELETE", `/api/live/${id}/link`);
    const k2 = new URL(replaced.link?.url ?? "").searchParams.get("k");
    expect((await guest("GET", `/api/live/${id}?k=${k2}`)).status).toBe(404);
    const log = (await (await o("GET", "/api/audit")).json()) as AuditPage;
    expect(auditLines(log.events)).toEqual(
      lines(
        ...[null, "comment", "comment", "watch"].map((role): [string, unknown] => [
          "live.link_changed",
          { run: id, role },
        ]),
      ),
    );
  });

  it("refuses a name nobody signs in under, and the owner's own", async () => {
    const { id, owner: o } = await shared();
    for (const login of ["nobody", "octo"]) {
      expect((await o("POST", `/api/live/${id}/people`, { login, role: "watch" })).status).toBe(
        400,
      );
    }
  });
});

describe("comments", () => {
  it("are removed by their author or the owner, never by another commenter", async () => {
    const o = await owner();
    const id = idOf((await o.relay(events.slice(0, 3))).watch);
    const ownerSend = as(o.web.auth);
    const mona = await signIn(2, "mona");
    const lisa = await signIn(3, "lisa");
    for (const login of ["mona", "lisa"])
      await ownerSend("POST", `/api/live/${id}/people`, { login, role: "comment" });
    const c = (await (
      await as(mona.auth)("POST", `/api/live/${id}/comments`, { body: "first" })
    ).json()) as LiveCommentView;
    expect((await as(lisa.auth)("DELETE", `/api/live/${id}/comments/${c.id}`)).status).toBe(404);
    const seen = (await (await as(lisa.auth)("GET", `/api/live/${id}/comments`)).json()) as {
      comments: LiveCommentView[];
    };
    expect(seen.comments.map((x) => [x.author, x.body, x.removable])).toEqual([
      ["mona", "first", false],
    ]);
    expect((await ownerSend("DELETE", `/api/live/${id}/comments/${c.id}`)).status).toBe(200);
  });

  it("refuse an empty body", async () => {
    const o = await owner();
    const id = idOf((await o.relay(events.slice(0, 3))).watch);
    expect((await as(o.web.auth)("POST", `/api/live/${id}/comments`, { body: "  " })).status).toBe(
      400,
    );
  });
});

describe("the live stream", () => {
  it("sends the events after Last-Event-ID and ends once the run ended", async () => {
    const o = await owner();
    const answer = await o.relay(events.slice(0, -1));
    const id = idOf(answer.watch);
    const res = await call(`/api/live/${id}/stream`, {
      auth: o.web.auth,
      headers: { "last-event-id": "16" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1])).toEqual(["17", "18"]);
    expect(text).toContain("event: end\ndata: finished");
  });
});
