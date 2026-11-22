import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { mergeRequestApi } from "./gitlab-merge-requests.js";
import { BOT, ISSUE, type Json, MR, PERSON, PROJECT, type Recorded } from "./gitlab-project.js";
import {
  type BareRepository,
  bareRepository,
  gitHttp,
  hungUp,
  readBody,
} from "./gitlab-repository.js";

export { BOT, ISSUE, MR, PERSON, PROJECT, STACKED } from "./gitlab-project.js";
export { companyCa } from "./gitlab-repository.js";

// A self-managed GitLab as a company runs it: its own certificate authority,
// installed under a relative URL root (/gitlab), and an OpenID Connect
// provider, an OAuth application, the REST and GraphQL APIs and git over
// HTTP on the same address. Its merge requests, notes, commits, merges and
// merge train are kept, so what ocra did can be read back.

const ROOT = "/gitlab";

/** The project's repository: main, feature on main, and backoff on feature. */
function repository(dir: string) {
  return bareRepository(
    dir,
    PROJECT.path,
    {
      main: { "retry.ts": "export function retries(limit: number) {\n  return limit;\n}\n" },
      feature: { "retry.ts": "export function retries(limit: number) {\n  return limit - 1;\n}\n" },
      backoff: { "backoff.ts": "export const backoff = (n: number) => 2 ** n * 100;\n" },
    },
    { feature: "main", backoff: "feature" },
  );
}

/** Starts the instance on 127.0.0.1; `close` stops it. */
export async function gitlabInstance(dir: string, tls: { key: Buffer; cert: Buffer }) {
  const repo: BareRepository = repository(dir);
  const requests: Recorded[] = [];
  let code = 0;
  const codes = new Map<string, string>();
  let url = "";
  const head = repo.at("feature");
  const userOf = (authorization: string | undefined) =>
    authorization === `Bearer ${BOT.token}`
      ? BOT
      : authorization === `Bearer ${PERSON.token}`
        ? PERSON
        : undefined;
  const mergeRequests = mergeRequestApi(repo, () => url);

  async function api(req: IncomingMessage, res: ServerResponse, path: string, body: unknown) {
    const json: Json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const user = userOf(req.headers.authorization);
    if (!user) return json({ message: "401 Unauthorized" }, 401);
    const query = new URL(req.url ?? "", "https://instance").searchParams;
    if (path === "/user") return json({ id: user.id, username: user.username });
    if (path === "/users") {
      const name = query.get("username");
      return json(
        [BOT, PERSON]
          .filter((u) => u.username === name)
          .map(({ id, username }) => ({ id, username })),
      );
    }
    const project = new RegExp(
      `^/projects/(${PROJECT.id}|${encodeURIComponent(PROJECT.path)})(/.*)?$`,
    ).exec(path);
    if (!project) return json({ message: "404 Not found" }, 404);
    const rest = project[2] ?? "";
    if (rest === "") {
      return json({
        id: PROJECT.id,
        path_with_namespace: PROJECT.path,
        default_branch: "main",
        web_url: `${url}/${PROJECT.path}`,
        visibility: "internal",
        resolve_outdated_diff_discussions: false,
        merge_trains_enabled: true,
      });
    }
    if (rest === "/repository/branches/main") return json({ commit: { id: repo.at("main") } });
    // The person is a Developer: their comments may ask ocra for an answer.
    if (rest === `/members/all/${PERSON.id}`) {
      return json({ id: PERSON.id, username: PERSON.username, access_level: 30 });
    }
    if (rest === `/issues/${ISSUE.iid}`) return json(issue());
    const handled = mergeRequests.route(req.method ?? "GET", rest, query, body, user, json);
    if (handled) return;
    if (rest.startsWith(`/statuses/`) && req.method === "POST") {
      mergeRequests.statuses.push(body);
      return json({ id: mergeRequests.statuses.length }, 201);
    }
    if (req.method === "GET") return json([]);
    return json({ message: "404 Not found" }, 404);
  }

  const issue = () => ({
    iid: ISSUE.iid,
    project_id: PROJECT.id,
    title: ISSUE.title,
    description: "A limit of 1 allows no retry.",
    state: "opened",
    labels: ISSUE.labels,
    web_url: `${url}/${PROJECT.path}/-/issues/${ISSUE.iid}`,
  });
  mergeRequests.closes.set(MR, issue);

  function oauth(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
    const json: Json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/.well-known/openid-configuration") {
      return json({
        issuer: url,
        authorization_endpoint: `${url}/oauth/authorize`,
        token_endpoint: `${url}/oauth/token`,
        userinfo_endpoint: `${url}/oauth/userinfo`,
      });
    }
    if (path === "/oauth/authorize") {
      const query = new URL(req.url ?? "", url).searchParams;
      const issued = `code-${++code}`;
      codes.set(issued, query.get("redirect_uri") ?? "");
      const back = new URL(query.get("redirect_uri") ?? "");
      back.searchParams.set("code", issued);
      back.searchParams.set("state", query.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === "/oauth/token") {
      const text = body.toString();
      const fields = req.headers["content-type"]?.includes("json")
        ? (JSON.parse(text) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(text));
      const issued = fields.code ?? "";
      if (fields.grant_type === "authorization_code" && codes.get(issued) !== fields.redirect_uri) {
        return json({ error: "invalid_grant" }, 400);
      }
      codes.delete(issued);
      return json({
        access_token: PERSON.token,
        refresh_token: "refresh-dana",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "api",
      });
    }
    if (path === "/oauth/userinfo") {
      if (req.headers.authorization !== `Bearer ${PERSON.token}`) return json({}, 401);
      return json({ sub: String(PERSON.id), preferred_username: PERSON.username });
    }
    return json({ message: "404 Not found" }, 404);
  }

  const graphql = () => ({
    data: {
      project: {
        mergeRequest: {
          // Who last edited each note: nobody did.
          notes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: mergeRequests.discussions
              .flatMap((d) => d.notes)
              .map((n) => ({ id: `gid://gitlab/Note/${n.id}`, lastEditedBy: null })),
          },
        },
      },
    },
  });

  // Requests still being answered, so that `close` returns only once none is
  // left writing to the repository the test then removes.
  const inFlight = new Set<Promise<unknown>>();
  const server: Server = createServer(tls, (req, res) => {
    const handled = handle(req, res).catch((error) => {
      if (!hungUp(error)) throw error;
    });
    inFlight.add(handled);
    const settle = () => inFlight.delete(handled);
    handled.then(settle, settle);
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const full = new URL(req.url ?? "/", "https://instance");
    const text = body.toString();
    requests.push({
      method: req.method ?? "GET",
      path: full.pathname,
      authorization: req.headers.authorization,
      body: req.headers["content-type"]?.includes("json") && text ? JSON.parse(text) : undefined,
    });
    if (!full.pathname.startsWith(`${ROOT}/`)) {
      res.writeHead(404);
      return res.end();
    }
    const path = full.pathname.slice(ROOT.length);
    try {
      if (path.startsWith("/api/v4/")) {
        return await api(req, res, path.slice("/api/v4".length), requests.at(-1)?.body);
      }
      if (path === "/api/graphql") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(graphql()));
      }
      if (path.startsWith(`/${PROJECT.path}.git/`)) {
        // Only the bot clones, with its token as git sends it.
        const basic = `Basic ${Buffer.from(`oauth2:${BOT.token}`).toString("base64")}`;
        if (req.headers.authorization !== basic) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="GitLab"' });
          return res.end();
        }
        return await gitHttp(repo.root, req, res, path, full.search.slice(1), body, BOT.username);
      }
      return oauth(req, res, path, body);
    } catch (error) {
      if (hungUp(error) || res.headersSent) throw error;
      res.writeHead(500);
      res.end(String(error));
    }
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}${ROOT}`;

  return {
    url,
    base: repo.at("main"),
    head,
    repo,
    requests,
    discussions: mergeRequests.discussions,
    statuses: mergeRequests.statuses,
    pulls: mergeRequests.pulls,
    commits: mergeRequests.commits,
    train: mergeRequests.train,
    comment: mergeRequests.comment,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([closed, ...inFlight]);
    },
  };
}

export type GitlabInstance = Awaited<ReturnType<typeof gitlabInstance>>;
