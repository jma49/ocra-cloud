import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { DAY, MINUTE } from "../src/time.js";
import { call, db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// Audit C7: a browser session ends after 7 days unused, and deleting the
// account, replacing a key or deleting the findings sent need a sign-in
// within the last minutes, not only a session.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const origin = { origin: ORIGIN };

/** A web session as if signed in `signedIn` ago and last used `used` ago. */
async function signedInAgo(signedIn: number, used: number | null = null) {
  const me = await signIn(1, "octo");
  const data = scoped(db, me.account.id);
  const [session] = await data.list("sessions");
  if (!session) throw new Error("no session");
  await data.update("sessions", session.id, {
    createdAt: new Date(Date.now() - signedIn),
    expiresAt: new Date(Date.now() - signedIn + 30 * DAY),
    lastUsedAt: used === null ? null : new Date(Date.now() - used),
  });
  return { ...me, data, sessionId: session.id };
}

describe("a browser session", () => {
  it("ends after 7 days unused, though its 30 days have not run out", async () => {
    const idle = await signedInAgo(10 * DAY, 8 * DAY);
    expect((await call("/api/me", { auth: idle.auth })).status).toBe(401);
    // Never used since a sign-in 8 days ago counts from the sign-in.
    await resetDb();
    const never = await signedInAgo(8 * DAY);
    expect((await call("/api/me", { auth: never.auth })).status).toBe(401);
  });

  it("lives on while it is used, until 30 days after its sign-in", async () => {
    const endOf = async (auth: Record<string, string>) => {
      const res = await call("/api/sessions", { auth });
      expect(res.status).toBe(200);
      const [s] = ((await res.json()) as { sessions: { expiresAt: string }[] }).sessions;
      return new Date(s?.expiresAt ?? 0).getTime();
    };
    // Used 6 days ago, and now by this request: 7 more days.
    const used = await signedInAgo(10 * DAY, 6 * DAY);
    expect(Math.abs((await endOf(used.auth)) - (Date.now() + 7 * DAY))).toBeLessThan(MINUTE);
    // Signed in 29 days ago: a day left, however recently used.
    await resetDb();
    const old = await signedInAgo(29 * DAY, 6 * DAY);
    expect(Math.abs((await endOf(old.auth)) - (Date.now() + DAY))).toBeLessThan(MINUTE);
  });
});

describe("a destructive change", () => {
  const refused = { error: "forbidden_for_session", reason: "recent_sign_in" };

  it("deletes the account only after a recent sign-in", async () => {
    const old = await signedInAgo(DAY, 0);
    const del = () =>
      call("/api/account", {
        method: "DELETE",
        auth: old.auth,
        headers: origin,
        json: { confirm: "octo" },
      });
    const res = await del();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(refused);
    expect(await old.data.count("sessions")).toBe(1);
    await old.data.update("sessions", old.sessionId, { createdAt: new Date() });
    expect((await del()).status).toBe(200);
  });

  it("replaces a stored key only after a recent sign-in, and adds a first one without", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const old = await signedInAgo(DAY, 0);
    const save = (provider: string, key: string) =>
      call(`/api/keys/${provider}`, {
        method: "PUT",
        auth: old.auth,
        headers: origin,
        json: { key },
      });
    expect((await save("openai", "sk-first-1111")).status).toBe(200);
    const replaced = await save("openai", "sk-second-2222");
    expect(replaced.status).toBe(403);
    expect(await replaced.json()).toEqual(refused);
    expect((await old.data.list("providerKeys")).map((k) => k.last4)).toEqual(["1111"]);
  });

  it("deletes the findings sent only after a recent sign-in; turning sharing off needs none", async () => {
    const old = await signedInAgo(DAY, 0);
    await old.data.insert("reviews", rows.reviews("r"));
    await old.data.insert("findings", { ...rows.findings("f"), reviewId: "r" });
    const off = (deleteExisting: boolean) =>
      call("/api/account/sharing", {
        method: "PUT",
        auth: old.auth,
        headers: origin,
        json: { enabled: false, deleteExisting },
      });
    const res = await off(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(refused);
    expect(await old.data.count("findings")).toBe(1);
    expect((await off(false)).status).toBe(200);
    expect(await old.data.count("findings")).toBe(1);
  });
});
