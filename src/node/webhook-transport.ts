import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { publicAddress } from "../notify/webhook-url.js";
import { MAX_ANSWER, type WebhookPost } from "../notify/webhooks.js";

// A webhook's POST on Node, where the server may sit on a private network:
// the connection goes only to the addresses the name resolved to, checked
// inside the lookup the socket itself uses, so a name that resolves to a
// private address, or rebinds to one between a check and the connect, is
// refused. A redirect is never followed (https.request follows none).

const TIMEOUT_MS = 10_000;

type Resolve = (host: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );

class Refused extends Error {
  override name = "Refused";
}

/** The lookup a socket uses: every address the name has must be public, or none is used. */
function checkedLookup(resolve: Resolve): LookupFunction {
  return (host, options, callback) => {
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every((a) => publicAddress(a.address))) {
          callback(new Refused("refused"), "", 4);
          return;
        }
        const wanted = options.family === 6 ? 6 : options.family === 4 ? 4 : undefined;
        const usable = addresses.filter((a) => wanted === undefined || a.family === wanted);
        if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
          return;
        }
        const first = usable[0];
        if (!first) callback(new Refused("refused"), "", 4);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 4),
    );
  };
}

/** Posts webhooks from Node; resolve is the resolver to check, the system's by default. */
export function nodeWebhookPost(resolve: Resolve = systemResolve): WebhookPost {
  return (url, init) =>
    new Promise((done) => {
      let settled = false;
      const finish = (r: Awaited<ReturnType<WebhookPost>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(r);
      };
      const req = request(
        url.toString(),
        {
          method: "POST",
          headers: { ...init.headers, "content-length": Buffer.byteLength(init.body) },
          lookup: checkedLookup(resolve),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let read = 0;
          res.on("data", (chunk: Buffer) => {
            read += chunk.byteLength;
            if (read > MAX_ANSWER) res.destroy();
          });
          const end = () =>
            finish(status >= 300 && status < 400 ? { error: "redirect" } : { status });
          res.on("end", end);
          res.on("close", end);
          res.on("error", end);
        },
      );
      // The whole call, answer included, not only an idle socket.
      const timer = setTimeout(() => {
        finish({ error: "timeout" });
        req.destroy();
      }, TIMEOUT_MS);
      req.on("error", (err) => finish({ error: err instanceof Refused ? "refused" : "network" }));
      req.end(init.body);
    });
}
