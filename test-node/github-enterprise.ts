import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { bareRepository, gitHttp, hungUp, readBody } from "./gitlab-repository.js";

// A GitHub Enterprise Server as a company runs it: its own certificate
// authority, the REST API under /api/v3, GraphQL at /api/graphql, OAuth and
// the App's pages on the web address, and git over HTTP. Only what a
// sign-in, an enrollment and a hosted review ask for is answered; every
// request is kept so the test can tell nothing went to github.com's paths.

export const REPO = { id: 314, fullName: "payments/ledger" };
export const PERSON = { id: 21, login: "dana", token: "ghu_dana" };
export const APP = { id: 77, slug: "ocra-review", installation: 5 };
export const BOT_TOKEN = "ghs_ocra_bot";
export const PR = 7;

type Recorded = { method: string; path: string; authorization?: string | undefined; body: unknown };

export async function githubEnterprise(dir: string, tls: { key: Buffer; cert: Buffer }) {
  const repo = bareRepository(
    dir,
    REPO.fullName,
    {
      main: { "retry.ts": "export function retries(limit: number) {\n  return limit;\n}\n" },
      feature: { "retry.ts": "export function retries(limit: number) {\n  return limit - 1;\n}\n" },
    },
    { feature: "main" },
  );
  repo.setRef(`refs/pull/${PR}/head`, repo.at("feature"));
  const requests: Recorded[] = [];
  const codes = new Map<string, string>();
  let url = "";

  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  function web(req: IncomingMessage, res: ServerResponse, path: string, body: unknown) {
    const query = new URL(req.url ?? "", url).searchParams;
    if (path === "/login/oauth/authorize") {
      const code = `code-${codes.size + 1}`;
      codes.set(code, query.get("redirect_uri") ?? "");
      const back = new URL(query.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === "/login/oauth/access_token" && req.method === "POST") {
      const fields = body as Record<string, string>;
      if (fields.client_id !== "ghes-app" || fields.client_secret !== "ghes-secret") {
        return json(res, { error: "incorrect_client_credentials" });
      }
      return json(res, {
        access_token: PERSON.token,
        refresh_token: "ghr_dana",
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
      });
    }
    res.writeHead(404);
    res.end();
  }

  const pull = () => ({
    number: PR,
    title: "Count retries from zero",
    body: null,
    html_url: `${url}/${REPO.fullName}/pull/${PR}`,
    user: { login: PERSON.login },
    base: { sha: repo.at("main"), ref: "main" },
    head: { sha: repo.at("feature"), ref: "feature" },
  });

  function rest(req: IncomingMessage, res: ServerResponse, path: string) {
    const auth = req.headers.authorization ?? "";
    const repoPath = `/repos/${REPO.fullName}`;
    if (path === "/app") return json(res, { id: APP.id, slug: APP.slug });
    if (path === `${repoPath}/installation`) return json(res, { id: APP.installation });
    if (path === `/app/installations/${APP.installation}/access_tokens`) {
      return json(res, { token: BOT_TOKEN }, 201);
    }
    if (auth !== `Bearer ${PERSON.token}` && auth !== `Bearer ${BOT_TOKEN}`) {
      return json(res, { message: "Bad credentials" }, 401);
    }
    if (path === "/user") return json(res, { id: PERSON.id, login: PERSON.login });
    if (path.startsWith("/user/installations?")) {
      return json(res, { installations: [{ id: APP.installation }] });
    }
    if (path.startsWith(`/user/installations/${APP.installation}/repositories`)) {
      return json(res, {
        repositories: [
          {
            id: REPO.id,
            full_name: REPO.fullName,
            private: true,
            html_url: `${url}/${REPO.fullName}`,
          },
        ],
      });
    }
    if (path === repoPath) {
      return json(res, { id: REPO.id, full_name: REPO.fullName, default_branch: "main" });
    }
    if (path === `${repoPath}/branches/main`)
      return json(res, { commit: { sha: repo.at("main") } });
    if (path === `${repoPath}/pulls/${PR}`) return json(res, pull());
    if (path.startsWith(`${repoPath}/pulls/${PR}/files`)) {
      return json(res, [
        {
          filename: "retry.ts",
          status: "modified",
          patch:
            "@@ -1,3 +1,3 @@\n export function retries(limit: number) {\n-  return limit;\n+  return limit - 1;\n }",
        },
      ]);
    }
    if (/\/collaborators\/[^/]+\/permission$/.test(path)) return json(res, { permission: "write" });
    if (req.method === "GET") return json(res, []);
    return json(res, { id: requests.length }, 201);
  }

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
    const raw = await readBody(req);
    const full = new URL(req.url ?? "/", "https://server");
    const text = raw.toString();
    const body =
      req.headers["content-type"]?.includes("json") && text ? JSON.parse(text) : undefined;
    const path = full.pathname;
    requests.push({
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization,
      body,
    });
    try {
      if (path.startsWith("/api/v3/"))
        return rest(req, res, path.slice("/api/v3".length) + full.search);
      if (path === "/api/graphql") {
        const query = (body as { query?: string } | undefined)?.query ?? "";
        return json(
          res,
          query.includes("reviewThreads")
            ? {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  },
                },
              }
            : { data: {} },
        );
      }
      if (path.startsWith(`/${REPO.fullName}.git/`)) {
        const basic = `Basic ${Buffer.from(`x-access-token:${BOT_TOKEN}`).toString("base64")}`;
        if (req.headers.authorization !== basic) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
          return res.end();
        }
        return await gitHttp(repo.root, req, res, path, full.search.slice(1), raw, "ocra");
      }
      return web(req, res, path, body);
    } catch (error) {
      if (hungUp(error) || res.headersSent) throw error;
      res.writeHead(500);
      res.end(String(error));
    }
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    head: repo.at("feature"),
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([closed, ...inFlight]);
    },
  };
}
