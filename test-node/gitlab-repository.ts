import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { finished } from "node:stream/promises";

// What the stand-in GitLab keeps on disk: the company's certificate
// authority, and the project's bare repository, written to as GitLab writes
// to it (commits from the API, merges) and served over git's smart HTTP.

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

const IDENTITY = {
  GIT_AUTHOR_NAME: "GitLab",
  GIT_AUTHOR_EMAIL: "gitlab@corp.example",
  GIT_COMMITTER_NAME: "GitLab",
  GIT_COMMITTER_EMAIL: "gitlab@corp.example",
};

// Whatever the machine's own git configuration says.
const git = (cwd: string, args: string[], extra: { input?: string; env?: object } = {}) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "push.negotiate=false", ...args], {
    cwd,
    encoding: "utf8",
    input: extra.input,
    env: { ...process.env, ...IDENTITY, ...extra.env },
  }).trim();

export type Branches = Record<string, Record<string, string>>;

/**
 * A bare repository at `<dir>/repos/<path>.git` with main and, for each
 * other branch, its files committed on top of the branch it names first.
 */
export function bareRepository(
  dir: string,
  path: string,
  branches: Branches,
  on: Record<string, string>,
) {
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "--quiet", "--initial-branch=main"]);
  for (const [branch, files] of Object.entries(branches)) {
    if (branch !== "main") git(work, ["checkout", "--quiet", "-b", branch, on[branch] ?? "main"]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
    git(work, ["add", "."]);
    git(work, ["commit", "--quiet", "-m", `update ${branch}`]);
  }
  const root = join(dir, "repos");
  const bare = join(root, `${path}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  git(work, ["push", "--quiet", bare, ...Object.keys(branches)]);

  const at = (ref: string) => git(bare, ["rev-parse", ref]);
  return {
    root,
    at,
    setRef: (ref: string, sha: string) => git(bare, ["update-ref", ref, sha]),
    mergeBase: (a: string, b: string) => git(bare, ["merge-base", a, b]),
    read: (ref: string, file: string) => git(bare, ["show", `${ref}:${file}`]),
    lastCommit: (ref: string, file: string) =>
      git(bare, ["log", "-1", "--format=%H", ref, "--", file]),
    contains(ref: string, sha: string) {
      try {
        git(bare, ["merge-base", "--is-ancestor", sha, ref]);
        return true;
      } catch {
        return false;
      }
    },
    /** Commits `content` to `file` on `branch`, as GitLab's commits API does. */
    commitFile(branch: string, file: string, content: Buffer, message: string) {
      const parent = at(branch);
      const blob = git(bare, ["hash-object", "-w", "--stdin"], { input: content.toString() });
      const index = { GIT_INDEX_FILE: join(dir, `index-${parent}`) };
      git(bare, ["read-tree", parent], { env: index });
      git(bare, ["update-index", "--cacheinfo", `100644,${blob},${file}`], { env: index });
      const tree = git(bare, ["write-tree"], { env: index });
      const sha = git(bare, ["commit-tree", tree, "-p", parent, "-m", message]);
      git(bare, ["update-ref", `refs/heads/${branch}`, sha, parent]);
      return sha;
    },
    /** Merges `sha` into `target` with a merge commit, as a merge request's merge does. */
    merge(target: string, sha: string, message: string) {
      const base = at(target);
      const tree = git(bare, ["merge-tree", "--write-tree", base, sha]).split("\n")[0] ?? "";
      const merged = git(bare, ["commit-tree", tree, "-p", base, "-p", sha, "-m", message]);
      git(bare, ["update-ref", `refs/heads/${target}`, merged, base]);
      return merged;
    },
  };
}

export type BareRepository = ReturnType<typeof bareRepository>;

/** A peer that closed its end first, as git does once it has what it needs; a real server shrugs it off. */
export const hungUp = (error: unknown) =>
  ["EPIPE", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "");

export const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** git's smart HTTP through git http-backend, from the repositories under `root`. */
export async function gitHttp(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: string,
  body: Buffer,
  user: string,
) {
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: path,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: user,
      REMOTE_ADDR: "127.0.0.1",
    } as unknown as NodeJS.ProcessEnv,
  });
  const exited = new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("close", () => done());
  });
  // http-backend may exit without reading the body (a missing repository), so
  // writing it can meet a closed pipe.
  child.stdin.end(body);
  const written = finished(child.stdin).catch((error) => {
    if (!hungUp(error)) throw error;
  });
  const [out] = await Promise.all([
    readBody(child.stdout as unknown as IncomingMessage),
    written,
    exited,
  ]);
  const split = out.indexOf("\r\n\r\n");
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of out.subarray(0, split).toString().split("\r\n")) {
    const [name, ...value] = line.split(":");
    if (!name) continue;
    if (name.toLowerCase() === "status") status = Number(value.join(":").trim().split(" ")[0]);
    else headers[name] = value.join(":").trim();
  }
  res.writeHead(status, headers);
  res.end(out.subarray(split + 4));
}
