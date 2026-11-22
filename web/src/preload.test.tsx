import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The first page's reads start along with /me only in a browser that was
// signed in when it last asked: the sign-in screen does not cost a /keys
// 401 on every load (#92).

const me = { login: "ada", githubId: 1, session: "web", since: "2026-10-01T00:00:00Z" };
const usage = { days: 14, today: 0, dailyLimit: 1000, series: [], models: [], calls: [] };

/** Loads the app at "/usage" (a page that shows the keys) with /me answered by `answer` (never, when undefined). */
async function load(answer: (() => Response) | undefined): Promise<string[]> {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/^\/api/, "");
      asked.push(path);
      if (path === "/me") return answer ? answer() : new Promise<Response>(() => {});
      if (path === "/keys") return Response.json({ error: "unauthenticated" }, { status: 401 });
      if (path === "/providers") return Response.json({ providers: [] });
      if (path === "/auth/methods") return Response.json({ methods: [GITHUB] });
      return Response.json(usage);
    }),
  );
  history.replaceState(null, "", "/usage");
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await import("./main.js");
  return asked;
}

const GITHUB = { id: "github", name: "GitHub" };
const signedOut = () => Response.json({ error: "unauthenticated" }, { status: 401 });

// Node's own localStorage, which needs a file, shadows the simulated
// browser's; each test gets an empty one of its own.
function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not read the first page's data on the sign-in screen", async () => {
  const asked = await load(signedOut);
  await screen.findByRole("link", { name: /Continue with GitHub/ });
  expect(asked).toContain("/me");
  expect(asked).not.toContain("/keys");
});

it("starts the first page's reads with /me once this browser was signed in", async () => {
  await load(() => Response.json(me));
  await screen.findByRole("heading", { name: /Overview|ada/ });
  const asked = await load(undefined);
  // The app from the earlier load may ask /keys on this fetch too, so wait
  // for both rather than reading /me once /keys shows up.
  await waitFor(() => expect(asked).toEqual(expect.arrayContaining(["/me", "/keys"])));
});

it("stops once /me finds the browser signed out", async () => {
  await load(() => Response.json(me));
  await screen.findByRole("heading", { name: /Overview|ada/ });
  await load(signedOut);
  await screen.findByRole("link", { name: /Continue with GitHub/ });
  const asked = await load(signedOut);
  await screen.findByRole("link", { name: /Continue with GitHub/ });
  expect(asked).not.toContain("/keys");
});
