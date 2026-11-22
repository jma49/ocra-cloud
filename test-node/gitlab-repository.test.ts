import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitHttp, readBody } from "./gitlab-repository.js";

let dir: string;
let server: Server;
let port: number;
const failures: unknown[] = [];
const record = (error: unknown) => failures.push(error);
let handled: Promise<void> = Promise.resolve();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-git-http-"));
  process.on("uncaughtException", record);
  server = createServer((req, res) => {
    handled = serve(req, res);
  });
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const url = new URL(req.url ?? "/", "http://git");
      await gitHttp(dir, req, res, url.pathname, url.search.slice(1), body, "bot");
    } catch (error) {
      record(error);
      res.destroy();
    }
  };
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  process.off("uncaughtException", record);
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: Buffer) =>
  new Promise<number>((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "x" } },
      (res) => {
        res.resume();
        res.on("end", () => done(res.statusCode ?? 0));
      },
    );
    req.on("error", fail);
    req.end(body);
  });

describe("git's smart HTTP stand-in", () => {
  // git http-backend refuses a missing repository without reading the request
  // body, so a body larger than a pipe's buffer is written into a closed pipe.
  it("answers a request git http-backend exits on without reading it", async () => {
    const status = await post("/missing.git/git-upload-pack", Buffer.alloc(4 << 20, "0"));
    expect(status).toBe(404);
    await handled;
    expect(failures).toEqual([]);
  });
});
