import { afterEach, assert, expect, it, vi } from "vitest";
import { gitlab, gitlabUser } from "../src/platforms/gitlab.js";
import { checkGitlabAccessToken } from "../src/platforms/repo-token.js";

const instance = "https://gitlab.example.test:8443";
const lab = gitlab({ url: instance, id: "client", secret: "client-secret" }, "https://app.test/");
const user = "user-token";
const project = "project-token";

afterEach(() => vi.restoreAllMocks());

function replyWith(response: Response) {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  return () => {
    expect(send).toHaveBeenCalledTimes(1);
    const [call] = send.mock.calls;
    assert(call);
    return new Request(...call);
  };
}

it.each([
  ["user", "/user", user, () => gitlabUser(instance, user), null],
  ["repositories", "/projects", user, () => lab.listRepos(user), null],
  ["contents", "/projects/group%2Frepo", user, () => lab.contents.head(user, "group/repo"), null],
  ["pulls", "/user", user, () => lab.listPulls(user, []), null],
  [
    "cycles",
    "/merge_requests",
    user,
    () => lab.cycles.merged(user, { mine: true }, new Date(0)),
    null,
  ],
  [
    "search",
    "/projects/group%2Frepo/merge_requests/1",
    user,
    () => lab.searchPulls(user, { repo: "group/repo", number: 1 }, 1),
    [],
  ],
  [
    "access check",
    "/user",
    project,
    () => checkGitlabAccessToken(instance, project, "1"),
    { ok: false, reason: "unreachable" },
  ],
] as const)(
  "%s sends its own bearer credential to the instance and handles a 404",
  async (_name, path, token, read, missing) => {
    const request = replyWith(new Response(null, { status: 404 }));
    expect(await read()).toEqual(missing);
    const req = request();
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(`${instance}/api/v4${path}`);
    expect(req.method).toBe("GET");
    expect(req.body).toBeNull();
    expect(req.redirect).toBe("manual");
    expect(Object.fromEntries(req.headers)).toEqual({
      accept: "application/json",
      authorization: `Bearer ${token}`,
    });
  },
);

it("stops tree pagination when the next page belongs to another origin", async () => {
  const request = replyWith(
    Response.json([], { headers: { link: '<https://other.test/page>; rel="next"' } }),
  );
  const repo = { platformRepoId: "1", fullName: "group/repo" };
  expect(await lab.contents.tree(user, repo, "abc")).toEqual({ entries: [], truncated: false });
  expect(new URL(request().url).origin).toBe(instance);
});

it("does not send a bearer credential to the OAuth token endpoint", async () => {
  const request = replyWith(Response.json({}));
  await lab.refresh("refresh-token");
  const req = request();
  expect(req.url).toBe(`${instance}/oauth/token`);
  expect(req.method).toBe("POST");
  expect(req.redirect).toBe("manual");
  expect(Object.fromEntries(req.headers)).toEqual({
    accept: "application/json",
    "content-type": "application/json",
  });
  expect(await req.json()).toEqual({
    client_id: "client",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
    redirect_uri: "https://app.test/",
  });
});
