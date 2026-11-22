import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// A self-managed GitLab as a company runs it: its own certificate authority,
// installed under a relative URL root (/gitlab), and an OpenID Connect
// provider, an OAuth application, the REST and GraphQL APIs and git over
// HTTP on the same address. Its merge request and notes are kept, so a
// review's comments can be read back and answered.

const ROOT = "/gitlab";
export const PROJECT = { id: 42, path: "platform/payments" };
export const BOT = { id: 900, username: "ocra-bot", token: "glpat-ocra-bot" };
export const PERSON = { id: 7, username: "dana", token: "gloas-dana" };
export const MR = 3;

type Recorded = { method: string; path: string; authorization: string | undefined; body: unknown };
type Note = {
  id: number;
  body: string;
  author: { id: number; username: string };
  system: false;
  type: string | null;
  resolvable: boolean;
  resolved: boolean;
  position?: unknown;
};
type Discussion = { id: string; individual_note: boolean; notes: Note[] };

/** A certificate authority and a certificate it signs for 127.0.0.1, made with openssl in `dir`. */
export function companyCa(dir: string) {
  const at = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Corp Root CA",
    "-keyout",
    at("ca.key"),
    "-out",
    at("ca.pem"),
  );
  writeFileSync(at("leaf.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
    "-keyout",
    at("leaf.key"),
    "-out",
    at("leaf.csr"),
  );
  openssl(
    "x509",
    "-req",
    "-in",
    at("leaf.csr"),
    "-CA",
    at("ca.pem"),
    "-CAkey",
    at("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    at("leaf.ext"),
    "-out",
    at("leaf.pem"),
  );
  return {
    caFile: at("ca.pem"),
    ca: readFileSync(at("ca.pem")),
    key: readFileSync(at("leaf.key")),
    cert: readFileSync(at("leaf.pem")),
  };
}

// Whatever the machine's own git configuration says.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "push.negotiate=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** The project's repository: main, and a feature branch whose merge request ref is MR's. */
function repository(dir: string) {
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.email", "dev@corp.example");
  git(work, "config", "user.name", "Dev");
  writeFileSync(
    join(work, "retry.ts"),
    "export function retries(limit: number) {\n  return limit;\n}\n",
  );
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "add retries");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(
    join(work, "retry.ts"),
    "export function retries(limit: number) {\n  return limit - 1;\n}\n",
  );
  git(work, "commit", "--quiet", "-am", "count retries from zero");
  const head = git(work, "rev-parse", "HEAD");
  const bare = join(dir, "repos", `${PROJECT.path}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  git(work, "push", "--quiet", bare, "main", "feature", `feature:refs/merge-requests/${MR}/head`);
  return { root: join(dir, "repos"), base, head };
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** Starts the instance on 127.0.0.1; `close` stops it. */
export async function gitlabInstance(dir: string, tls: { key: Buffer; cert: Buffer }) {
  const repo = repository(dir);
  const requests: Recorded[] = [];
  const discussions: Discussion[] = [];
  const statuses: unknown[] = [];
  let nextId = 1000;
  let code = 0;
  const codes = new Map<string, string>();
  let url = "";

  const note = (author: { id: number; username: string }, body: string, extra = {}): Note => ({
    id: nextId++,
    body,
    author: { id: author.id, username: author.username },
    system: false,
    type: null,
    resolvable: false,
    resolved: false,
    ...extra,
  });
  const userOf = (authorization: string | undefined) =>
    authorization === `Bearer ${BOT.token}`
      ? BOT
      : authorization === `Bearer ${PERSON.token}`
        ? PERSON
        : undefined;

  const mergeRequest = () => ({
    iid: MR,
    id: 5000,
    project_id: PROJECT.id,
    title: "Count retries from zero",
    description: "Retries start at zero now.",
    state: "opened",
    draft: false,
    author: { id: PERSON.id, username: PERSON.username },
    web_url: `${url}/${PROJECT.path}/-/merge_requests/${MR}`,
    source_project_id: PROJECT.id,
    target_project_id: PROJECT.id,
    source_branch: "feature",
    target_branch: "main",
    sha: repo.head,
    labels: [],
    diff_refs: { base_sha: repo.base, start_sha: repo.base, head_sha: repo.head },
  });

  async function api(req: IncomingMessage, res: ServerResponse, path: string, body: unknown) {
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const user = userOf(req.headers.authorization);
    if (!user) return json({ message: "401 Unauthorized" }, 401);
    const method = req.method ?? "GET";
    if (path === "/user") return json({ id: user.id, username: user.username });
    if (path === "/users") {
      const name = new URL(req.url ?? "", url).searchParams.get("username");
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
      });
    }
    if (rest === "/repository/branches/main") return json({ commit: { id: repo.base } });
    // The person is a Developer: their comments may ask ocra for an answer.
    if (rest === `/members/all/${PERSON.id}`) {
      return json({ id: PERSON.id, username: PERSON.username, access_level: 30 });
    }
    if (rest === `/merge_requests/${MR}`) return json(mergeRequest());
    if (rest === `/merge_requests/${MR}/discussions` && method === "GET") return json(discussions);
    if (rest === `/merge_requests/${MR}/notes` && method === "GET") {
      return json(discussions.flatMap((d) => d.notes));
    }
    const fields = (body ?? {}) as { body?: string; position?: unknown };
    if (rest === `/merge_requests/${MR}/discussions` && method === "POST") {
      const first = note(user, fields.body ?? "", {
        type: fields.position ? "DiffNote" : "DiscussionNote",
        resolvable: true,
        ...(fields.position ? { position: fields.position } : {}),
      });
      const discussion = { id: `d${first.id}`, individual_note: false, notes: [first] };
      discussions.push(discussion);
      return json(discussion, 201);
    }
    if (rest === `/merge_requests/${MR}/notes` && method === "POST") {
      const created = note(user, fields.body ?? "");
      discussions.push({ id: `d${created.id}`, individual_note: true, notes: [created] });
      return json(created, 201);
    }
    const reply = new RegExp(`^/merge_requests/${MR}/discussions/([^/]+)/notes$`).exec(rest);
    if (reply && method === "POST") {
      const discussion = discussions.find((d) => d.id === decodeURIComponent(reply[1] ?? ""));
      if (!discussion) return json({ message: "404 Discussion Not Found" }, 404);
      const created = note(user, fields.body ?? "", { type: "DiscussionNote" });
      discussion.notes.push(created);
      return json(created, 201);
    }
    const edit = new RegExp(`^/merge_requests/${MR}/notes/(\\d+)$`).exec(rest);
    if (edit && method === "PUT") {
      const found = discussions.flatMap((d) => d.notes).find((n) => n.id === Number(edit[1]));
      if (!found) return json({ message: "404 Note Not Found" }, 404);
      found.body = fields.body ?? found.body;
      return json(found);
    }
    if (rest.startsWith(`/statuses/`) && method === "POST") {
      statuses.push(body);
      return json({ id: nextId++ }, 201);
    }
    if (method === "GET") return json([]);
    return json({ message: "404 Not found" }, 404);
  }

  function oauth(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
    const json = (value: unknown, status = 200) => {
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

  // git's smart HTTP through git http-backend, for the bot's token only.
  async function gitHttp(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
    const basic = `Basic ${Buffer.from(`oauth2:${BOT.token}`).toString("base64")}`;
    if (req.headers.authorization !== basic) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitLab"' });
      return res.end();
    }
    const query = new URL(req.url ?? "", url).search.slice(1);
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: repo.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: path,
        QUERY_STRING: query,
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: BOT.username,
        REMOTE_ADDR: "127.0.0.1",
      } as unknown as NodeJS.ProcessEnv,
    });
    child.stdin.end(body);
    const out = await readBody(child.stdout as unknown as IncomingMessage);
    const split = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, split).toString();
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.split("\r\n")) {
      const [name, ...value] = line.split(":");
      if (!name) continue;
      if (name.toLowerCase() === "status") status = Number(value.join(":").trim().split(" ")[0]);
      else headers[name] = value.join(":").trim();
    }
    res.writeHead(status, headers);
    res.end(out.subarray(split + 4));
  }

  const server: Server = createServer(tls, async (req, res) => {
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
        return res.end(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  // Who last edited each note: nobody did.
                  notes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: discussions
                      .flatMap((d) => d.notes)
                      .map((n) => ({ id: `gid://gitlab/Note/${n.id}`, lastEditedBy: null })),
                  },
                },
              },
            },
          }),
        );
      }
      if (path.startsWith(`/${PROJECT.path}.git/`)) {
        return await gitHttp(req, res, path, body);
      }
      return oauth(req, res, path, body);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}${ROOT}`;

  return {
    url,
    base: repo.base,
    head: repo.head,
    requests,
    discussions,
    statuses,
    /** A person's comment on the merge request, in a new thread. */
    comment(body: string) {
      const created = note(PERSON, body, { type: "DiscussionNote", resolvable: true });
      discussions.push({ id: `d${created.id}`, individual_note: false, notes: [created] });
      return created;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type GitlabInstance = Awaited<ReturnType<typeof gitlabInstance>>;
