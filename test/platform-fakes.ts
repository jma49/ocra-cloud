import { expect, vi } from "vitest";
import { call, ORIGIN } from "./helpers.js";

export const SESSION = "__Host-ocra_session";
/** The self-hosted GitLab of vitest.config.ts. */
export const GITLAB = "https://gitlab.example.com:8443";
const STATE = "__Host-ocra_oauth_state";

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [k, v] = (line.split(";")[0] ?? "").split("=");
    if (k === name) return v;
  }
  return undefined;
}

type Fake = {
  refresh?: () => Response;
  extra?: (req: Request) => Promise<Response | undefined> | Response | undefined;
};

export function githubFake(fake: Fake = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    const answer = await fake.extra?.(req.clone());
    if (answer) return answer;
    if (url === "https://github.com/login/oauth/access_token") {
      const body = (await req.json()) as { grant_type?: string };
      if (body.grant_type === "refresh_token") {
        return fake.refresh?.() ?? Response.json({ error: "bad_refresh_token" });
      }
      return Response.json({
        access_token: "ghu_first",
        refresh_token: "ghr_first",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "octo" });
    if (url.startsWith("https://api.github.com/user/installations/7/repositories")) {
      return Response.json({
        repositories: [
          { id: 1, full_name: "Octo/API", private: true, html_url: "https://github.com/Octo/API" },
          { id: 2, full_name: "octo/web", private: false, html_url: "https://github.com/octo/web" },
        ],
      });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return Response.json({
        installations: [{ id: 7, account: { login: "octo", type: "Organization" } }],
      });
    }
    if (url === `${GITLAB}/oauth/token`) {
      const body = (await req.json()) as { grant_type?: string; client_secret?: string };
      if (body.client_secret !== "test-gitlab-secret") return new Response(null, { status: 401 });
      return Response.json({
        access_token: "glpat_first",
        refresh_token: "glr_first",
        expires_in: 7200,
      });
    }
    if (url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77, username: "Lab.User" });
    if (url.startsWith(`${GITLAB}/api/v4/projects?membership=true`)) {
      if (req.headers.get("authorization") !== "Bearer glpat_first") {
        return new Response(null, { status: 401 });
      }
      return Response.json([
        {
          id: 9,
          path_with_namespace: "Group/Sub/Project",
          web_url: `${GITLAB}/Group/Sub/Project`,
          visibility: "private",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

export async function signInWithGithub() {
  const start = await call("/api/auth/github/login");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const res = await call(`/api/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${STATE}=${cookieValue(start, STATE)}` },
  });
  const cookie = `${SESSION}=${cookieValue(res, SESSION)}`;
  const send = (path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { cookie, origin: ORIGIN, ...init.headers } });
  return { send, cookie };
}

export async function connectGitlab(a: Awaited<ReturnType<typeof signInWithGithub>>) {
  const start = await a.send("/api/platforms/gitlab/connect");
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location") ?? "");
  expect(to.origin + to.pathname).toBe(`${GITLAB}/oauth/authorize`);
  expect(to.searchParams.get("scope")).toBe("api");
  const state = to.searchParams.get("state") ?? "";
  const stateCookie = `__Host-ocra_gitlab_state=${cookieValue(start, "__Host-ocra_gitlab_state")}`;
  return (query: string, cookie = a.cookie) =>
    call(`/api/platforms/gitlab/callback?${query.replace("STATE", state)}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
}
